//! Tauri command surface for the animation tool.
//!
//! The project lives in a single `Mutex<Project>` owned by Tauri state. The
//! frontend reads structure once with `get_project` and asks for resolved
//! transforms per playhead time with `evaluate_at`.

mod eval;
mod model;
mod surface;
mod text;

use std::collections::HashMap;
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::{Manager, State};

use eval::ResolvedLayer;
use model::{
    ColorKey, ConstrainMode, CropRect, Decal, DropShadow, Easing, Effect, FrameCell, GridVertex,
    Keyframe, Layer, LayerKind, LetterAnimation, LetterOverride, LinkedEffectGroup, Project, Rgba,
    Shape2DStyle, SurfaceShape, TextLayerStyles, Track, Transform, TransformEdit, Transition,
    TransitionKind, VectorShape,
};
use text::{Font, FontFace, ShapedText, TextAlign};

/// Shortest play range a layer is allowed to have, and the floor for the comp
/// duration (ms). Keeps a trimmed block from collapsing to nothing.
const MIN_SPAN_MS: u32 = 50;

/// Default end time for a freshly added layer: a quarter of the comp length, so
/// new layers don't span the whole timeline (the user then trims/extends them).
fn default_new_layer_end(duration_ms: u32) -> u32 {
    (duration_ms / 4).max(MIN_SPAN_MS).min(duration_ms.max(MIN_SPAN_MS))
}

/// Undo/redo stacks of whole-project snapshots. Each user-level mutation pushes
/// the pre-change project onto `undo`.
#[derive(Default)]
struct History {
    undo: Vec<Project>,
    redo: Vec<Project>,
}

/// One level of "inside a group" navigation: the parent scope's layers (with the
/// group still in place, its children emptied while they're live in `project`)
/// and which group we descended into, so `exit_group` can re-nest the edits.
struct NavFrame {
    parent_layers: Vec<Layer>,
    group_id: u32,
}

/// App-wide mutable state. `shaped` caches the shaped glyphs per text layer so we
/// don't re-shape every frame; it's rebuilt whenever a layer's text changes.
/// `nav` is the group-editing stack (empty = editing the root comp).
/// Lock order is always project → history → shaped to avoid deadlock.
struct AppState {
    project: Mutex<Project>,
    shaped: Mutex<HashMap<u32, ShapedText>>,
    history: Mutex<History>,
    nav: Mutex<Vec<NavFrame>>,
    /// A `.sefx` path passed on the command line (e.g. the OS double-clicking an
    /// associated file). Consumed once by the frontend on startup.
    launch_file: Mutex<Option<String>>,
}

impl AppState {
    /// Record the current project so the next mutation can be undone (clears
    /// redo). Call BEFORE mutating, passing the current project.
    fn snapshot(&self, current: &Project) {
        const CAP: usize = 200;
        let mut h = self.history.lock().unwrap();
        h.undo.push(current.clone());
        if h.undo.len() > CAP {
            let excess = h.undo.len() - CAP;
            h.undo.drain(0..excess);
        }
        h.redo.clear();
    }
}

/// (Re)shape a single layer into the cache if it's a text layer.
fn reshape_layer(shaped: &mut HashMap<u32, ShapedText>, layer: &Layer) {
    if let LayerKind::Text { content, size, font, weight, italic, align, .. } = &layer.kind {
        shaped.insert(layer.id, text::shape_aligned(content, *size, font, *weight, *italic, *align));
    }
}

/// Shape a layer and (recursively) any layers nested inside a group.
fn reshape_recursive(shaped: &mut HashMap<u32, ShapedText>, layer: &Layer) {
    reshape_layer(shaped, layer);
    if let LayerKind::Group { children } = &layer.kind {
        for c in children {
            reshape_recursive(shaped, c);
        }
    }
}

/// Rebuild the whole shaping cache from a project (after undo/redo/load).
fn reshape_all(project: &Project, shaped: &mut HashMap<u32, ShapedText>) {
    shaped.clear();
    for l in &project.layers {
        reshape_recursive(shaped, l);
    }
}

/// Hand the whole project to the frontend (structure + keyframes).
#[tauri::command]
fn get_project(state: State<AppState>) -> Project {
    state.project.lock().unwrap().clone()
}

/// Replace the project wholesale (used by load). Undoable.
#[tauri::command]
fn set_project(state: State<AppState>, project: Project) {
    let mut current = state.project.lock().unwrap();
    state.snapshot(&current);
    let mut shaped = state.shaped.lock().unwrap();
    reshape_all(&project, &mut shaped);
    *current = project;
}

/// Replace the project's media bin (imported file paths). Held on the project so
/// it's saved with the file — reopening restores the bin; a new project is empty.
/// Not undoable (bin management isn't part of the edit history).
#[tauri::command]
fn set_media(state: State<AppState>, media: Vec<String>) -> Project {
    let mut project = state.project.lock().unwrap();
    project.media = media;
    project.clone()
}

/// Start a fresh, blank project: clear the timeline and reset undo/redo and the
/// group-navigation stack. Returns the new empty project. Not undoable (it's a
/// deliberate "start over"), matching how the app boots.
#[tauri::command]
fn new_project(state: State<AppState>) -> Project {
    let project = Project::empty();
    let mut current = state.project.lock().unwrap();
    let mut shaped = state.shaped.lock().unwrap();
    reshape_all(&project, &mut shaped);
    *current = project;
    *state.history.lock().unwrap() = History::default();
    state.nav.lock().unwrap().clear();
    current.clone()
}

/// Undo the last mutation; returns the restored project (or `None` if nothing to
/// undo). Rebuilds the shaping cache so text layers stay consistent.
#[tauri::command]
fn undo(state: State<AppState>) -> Option<Project> {
    let mut project = state.project.lock().unwrap();
    let mut h = state.history.lock().unwrap();
    let prev = h.undo.pop()?;
    h.redo.push(project.clone());
    *project = prev;
    let mut shaped = state.shaped.lock().unwrap();
    reshape_all(&project, &mut shaped);
    Some(project.clone())
}

/// Redo the last undone mutation; returns the restored project (or `None`).
#[tauri::command]
fn redo(state: State<AppState>) -> Option<Project> {
    let mut project = state.project.lock().unwrap();
    let mut h = state.history.lock().unwrap();
    let next = h.redo.pop()?;
    h.undo.push(project.clone());
    *project = next;
    let mut shaped = state.shaped.lock().unwrap();
    reshape_all(&project, &mut shaped);
    Some(project.clone())
}

/// Write text to an absolute path (used by the session recorder to save its log).
#[tauri::command]
fn save_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("write {path}: {e}"))
}

/// Resolve every layer's transform at one playhead time. This is the authority
/// the preview renders from — identical to what the export pipeline will use.
#[tauri::command]
fn evaluate_at(state: State<AppState>, t_ms: u32) -> Vec<ResolvedLayer> {
    let project = state.project.lock().unwrap();
    let shaped = state.shaped.lock().unwrap();
    let counts: HashMap<u32, usize> =
        shaped.iter().map(|(id, st)| (*id, st.glyphs.len())).collect();
    // Text layers pinned to a shape need their shaped bounding box (for the
    // decal's aspect ratio): width × (ascender + descender).
    let text_dims: HashMap<u32, (f32, f32)> = shaped
        .iter()
        .map(|(id, st)| {
            let h = st.ascender + st.descender + (st.lines.max(1) - 1) as f32 * st.line_height;
            (*id, (st.width, h))
        })
        .collect();
    eval::evaluate(&project, t_ms, &counts, &text_dims)
}

/// Hand the shaped glyphs of a text layer to the frontend so it can draw the
/// outlines (Arabic intact). `None` if the layer isn't text / not shaped yet.
#[tauri::command]
fn get_shaped(state: State<AppState>, layer_id: u32) -> Option<ShapedText> {
    state.shaped.lock().unwrap().get(&layer_id).cloned()
}

/// Add a new text layer centred in the comp, and shape it.
#[tauri::command]
fn add_text_layer(state: State<AppState>, content: String, size: f32) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let next_id = max_layer_id(&project.layers) + 1;
    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    let end_ms = default_new_layer_end(project.duration_ms);
    let font = Font("Vazirmatn".into());
    let shaped = text::shape(&content, size, &font, 400, false);
    project.layers.push(Layer {
        id: next_id,
        name: "Text".into(),
        start_ms: 0,
        end_ms,
        kind: LayerKind::Text {
            content,
            size,
            align: TextAlign::Center,
            color: Rgba { r: 245, g: 245, b: 250, a: 255 },
            color_keys: vec![],
            font,
            weight: 400,
            italic: false,
            anim: None,
            parts: vec![],
            // Full strength: per-letter overrides apply directly, so keyframing a
            // decomposed letter animates it without also keying this amount. Key
            // it toward 0 to gather the letters back for an explode/assemble.
            decompose: Track::constant(1.0),
            style: None,
            animators: vec![],
            layer_styles: None,
            per_char_3d: false,
            per_char_rx: 0.0,
            per_char_ry: 0.0,
            per_char_spread: 0.0,
        },
        transform: Transform::at(cx, cy),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });
    state.shaped.lock().unwrap().insert(next_id, shaped);
    project.clone()
}

/// Add a blank adjustment layer spanning the whole comp. Its effect stack
/// (layer.effects) applies to every layer below it — add any effect from the
/// inspector (colour/blur effects re-grade the layers below; shiny clouds and
/// pattern GPU effects overlay on top).
#[tauri::command]
fn add_adjustment_layer(state: State<AppState>) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let next_id = max_layer_id(&project.layers) + 1;
    let dur = project.duration_ms;
    project.layers.push(Layer {
        id: next_id,
        name: "Adjustment".into(),
        start_ms: 0,
        end_ms: dur,
        kind: LayerKind::Adjustment {},
        transform: Transform::at(0.0, 0.0),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });
    project.clone()
}

/// Update a text layer's content / size and re-shape it.
#[tauri::command]
fn set_text_content(
    state: State<AppState>,
    layer_id: u32,
    content: String,
    size: f32,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let (font, weight, italic, align) = match &mut layer.kind {
        LayerKind::Text { content: c, size: s, font, weight, italic, align, .. } => {
            *c = content.clone();
            *s = size;
            (font.clone(), *weight, *italic, *align)
        }
        _ => return Err("not a text layer".into()),
    };
    state
        .shaped
        .lock()
        .unwrap()
        .insert(layer_id, text::shape_aligned(&content, size, &font, weight, italic, align));
    Ok(project.clone())
}

/// Insert or update a text colour keyframe at `t_ms`.
///
/// `seed_start`: if there are no keys yet and the edit is *after* the layer's
/// start, first drop a key at the start holding the previous colour — so a single
/// colour change at a later frame animates from the clip's beginning rather than
/// recolouring the whole clip. One key = a constant colour (no animation).
fn upsert_color_key(
    keys: &mut Vec<ColorKey>,
    t_ms: u32,
    color: Rgba,
    prev: Rgba,
    seed_start: bool,
    start_ms: u32,
) {
    if keys.is_empty() && seed_start && start_ms < t_ms {
        keys.push(ColorKey { time_ms: start_ms, color: prev, easing: Easing::EaseInOut });
    }
    if let Some(k) = keys.iter_mut().find(|k| k.time_ms == t_ms) {
        k.color = color;
    } else {
        keys.push(ColorKey { time_ms: t_ms, color, easing: Easing::EaseInOut });
        keys.sort_by(|a, b| a.time_ms.cmp(&b.time_ms));
    }
}

/// Change a text layer's fill colour by keying it at the playhead (`t_ms`), so
/// colour animates over the clip instead of applying to the whole timeline.
#[tauri::command]
fn set_text_color(
    state: State<AppState>,
    layer_id: u32,
    color: Rgba,
    t_ms: u32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let start = layer.start_ms;
    match &mut layer.kind {
        LayerKind::Text { color: c, color_keys, .. } => {
            let prev = color_keys.last().map(|k| k.color).unwrap_or(*c);
            upsert_color_key(color_keys, t_ms, color, prev, seed_start, start);
            // Keep the static fill in sync with the first key so the swatch and
            // any renderer that ignores keys still shows a sensible colour.
            if let Some(first) = color_keys.first() {
                *c = first.color;
            }
        }
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Clear all text colour keyframes, collapsing back to a single static fill.
#[tauri::command]
fn clear_text_color_keys(
    state: State<AppState>,
    layer_id: u32,
    color: Rgba,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Text { color: c, color_keys, .. } => {
            color_keys.clear();
            *c = color;
        }
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Change a text layer's font and re-shape it.
#[tauri::command]
fn set_text_font(state: State<AppState>, layer_id: u32, font: Font) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let (content, size, weight, italic, align) = {
        let layer = project
            .layers
            .iter_mut()
            .find(|l| l.id == layer_id)
            .ok_or("layer not found")?;
        match &mut layer.kind {
            LayerKind::Text { content, size, font: f, weight, italic, align, .. } => {
                *f = font.clone();
                (content.clone(), *size, *weight, *italic, *align)
            }
            _ => return Err("not a text layer".into()),
        }
    };
    state
        .shaped
        .lock()
        .unwrap()
        .insert(layer_id, text::shape_aligned(&content, size, &font, weight, italic, align));
    Ok(project.clone())
}

/// Change a text layer's weight (100..900) and/or italic, then re-shape it.
#[tauri::command]
fn set_text_font_style(
    state: State<AppState>,
    layer_id: u32,
    weight: u16,
    italic: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let (content, size, font, align) = {
        let layer = project
            .layers
            .iter_mut()
            .find(|l| l.id == layer_id)
            .ok_or("layer not found")?;
        match &mut layer.kind {
            LayerKind::Text { content, size, font, weight: w, italic: it, align, .. } => {
                *w = weight.clamp(100, 900);
                *it = italic;
                (content.clone(), *size, font.clone(), *align)
            }
            _ => return Err("not a text layer".into()),
        }
    };
    state
        .shaped
        .lock()
        .unwrap()
        .insert(layer_id, text::shape_aligned(&content, size, &font, weight.clamp(100, 900), italic, align));
    Ok(project.clone())
}

/// Set a text layer's horizontal alignment (left / center / right) and re-shape.
#[tauri::command]
fn set_text_align(state: State<AppState>, layer_id: u32, align: TextAlign) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Text { align: a, .. } => *a = align,
        _ => return Err("not a text layer".into()),
    }
    let mut shaped = state.shaped.lock().unwrap();
    reshape_layer(&mut shaped, layer);
    Ok(project.clone())
}

/// List every selectable font family (built-ins first, then system fonts).
/// Re-scans the OS each call, so fonts installed while the app is running show up
/// (and become resolvable when shaping).
#[tauri::command]
fn list_fonts() -> Vec<String> {
    text::reload_fonts();
    text::list_font_families()
}

/// The available styles (faces) of one font family — Regular, Medium, Bold,
/// Thin, Bold Italic, etc. — for the Style dropdown. Reads the already-loaded
/// font db (populated by `list_fonts`).
#[tauri::command]
fn font_styles(family: String) -> Vec<FontFace> {
    text::list_font_styles(&family)
}

/// Set (or clear) the per-letter animation preset on a text layer.
#[tauri::command]
fn set_text_anim(
    state: State<AppState>,
    layer_id: u32,
    anim: Option<LetterAnimation>,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Text { anim: a, .. } => *a = anim,
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Set (or clear) the typographic + fill/stroke style on a text layer. Static
/// (no reshape needed) — the renderer reads it directly.
#[tauri::command]
fn set_text_style(
    state: State<AppState>,
    layer_id: u32,
    style: Option<crate::model::TextStyle>,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Text { style: s, .. } => *s = style,
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Set a text layer's After Effects-style per-character animators.
#[tauri::command]
fn set_text_animators(
    state: State<AppState>,
    layer_id: u32,
    animators: Vec<crate::model::TextAnimator>,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Text { animators: a, .. } => *a = animators,
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Set (or clear) a text layer's whole-layer styles (shadow/glow/bevel/gradient).
#[tauri::command]
fn set_text_layer_styles(
    state: State<AppState>,
    layer_id: u32,
    styles: Option<crate::model::TextLayerStyles>,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Text { layer_styles, .. } => *layer_styles = styles,
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Toggle per-character 3D on a text layer and set its base rotation controls
/// (degrees): `rx`/`ry` applied to every glyph about its own centre, `spread`
/// adding `index * spread` to the Y rotation.
#[tauri::command]
fn set_text_per_char_3d(
    state: State<AppState>,
    layer_id: u32,
    enabled: bool,
    rx: f32,
    ry: f32,
    spread: f32,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Text { per_char_3d, per_char_rx, per_char_ry, per_char_spread, .. } => {
            *per_char_3d = enabled;
            *per_char_rx = rx;
            *per_char_ry = ry;
            *per_char_spread = spread;
        }
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Append an image layer pointing at an absolute path, returning the new project.
#[tauri::command]
fn add_image_layer(state: State<AppState>, path: String) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let next_id = max_layer_id(&project.layers) + 1;
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Image".into());
    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    let end_ms = default_new_layer_end(project.duration_ms);

    // Read the image header for its natural size, then scale it to *contain*
    // within the comp so big photos don't overflow the frame.
    let (iw, ih) = image::image_dimensions(&path).unwrap_or((project.width, project.height));
    let (iw, ih) = (iw.max(1), ih.max(1));
    let fit = (project.width as f32 / iw as f32).min(project.height as f32 / ih as f32);

    let mut transform = Transform::at(cx, cy);
    transform.scale_x = Track::constant(fit);
    transform.scale_y = Track::constant(fit);

    project.layers.push(Layer {
        id: next_id,
        name,
        start_ms: 0,
        end_ms,
        kind: LayerKind::Image { src: path, width: iw, height: ih, crop: None },
        transform,
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });
    project.clone()
}

/// Add a video layer. The frontend reads the video's natural size + duration
/// (via an `HTMLVideoElement`) and passes them in, so Rust can scale-to-fit like
/// an image without needing a media decoder. Undoable.
#[tauri::command]
fn add_video_layer(
    state: State<AppState>,
    path: String,
    width: u32,
    height: u32,
    duration_ms: u32,
) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let next_id = max_layer_id(&project.layers) + 1;
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Video".into());
    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    // Trim to the video's own length when known, else the standard 25% default.
    let end_ms = if duration_ms > 0 {
        duration_ms.clamp(MIN_SPAN_MS, project.duration_ms.max(MIN_SPAN_MS))
    } else {
        default_new_layer_end(project.duration_ms)
    };
    let (iw, ih) = (width.max(1), height.max(1));
    let fit = (project.width as f32 / iw as f32).min(project.height as f32 / ih as f32);
    let mut transform = Transform::at(cx, cy);
    transform.scale_x = Track::constant(fit);
    transform.scale_y = Track::constant(fit);
    project.layers.push(Layer {
        id: next_id,
        name,
        start_ms: 0,
        end_ms,
        kind: LayerKind::Video { src: path, width: iw, height: ih, duration_ms },
        transform,
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });
    project.clone()
}

/// Add an audio layer (no visual). `duration_ms` is read on the frontend. Undoable.
#[tauri::command]
fn add_audio_layer(state: State<AppState>, path: String, duration_ms: u32) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let next_id = max_layer_id(&project.layers) + 1;
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Audio".into());
    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    let end_ms = if duration_ms > 0 {
        duration_ms.clamp(MIN_SPAN_MS, project.duration_ms.max(MIN_SPAN_MS))
    } else {
        default_new_layer_end(project.duration_ms)
    };
    project.layers.push(Layer {
        id: next_id,
        name,
        start_ms: 0,
        end_ms,
        kind: LayerKind::Audio { src: path, duration_ms },
        transform: Transform::at(cx, cy),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });
    project.clone()
}

/// Scale an image layer to *contain* within the composition (preserving aspect
/// ratio) and centre it — the same fit applied when an image is first added.
/// Replaces the scale/position tracks with constants (drops any keyframes on
/// them), leaving rotation and opacity untouched.
#[tauri::command]
fn scale_layer_to_fit(state: State<AppState>, layer_id: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let (cw, ch) = (project.width as f32, project.height as f32);
    let (cx, cy) = (cw / 2.0, ch / 2.0);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let (iw, ih) = match &layer.kind {
        LayerKind::Image { width, height, .. } => (*width as f32, *height as f32),
        _ => return Err("scale to fit is for image layers".into()),
    };
    let fit = (cw / iw.max(1.0)).min(ch / ih.max(1.0));
    layer.transform.scale_x = Track::constant(fit);
    layer.transform.scale_y = Track::constant(fit);
    layer.transform.x = Track::constant(cx);
    layer.transform.y = Track::constant(cy);
    Ok(project.clone())
}

/// Insert or update a keyframe at `t_ms` on a track.
///
/// `seed_start`: if the track is empty (a constant) and the edit is happening
/// *after* the layer's start, first drop a keyframe at the start holding the old
/// value — so a single edit at a later frame produces an animation from the
/// layer's beginning, not just a static jump.
fn upsert_key(track: &mut Track, t_ms: u32, value: Option<f32>, seed_start: bool, start_ms: u32) {
    let Some(value) = value else { return };
    if track.keys.is_empty() && seed_start && start_ms < t_ms {
        track.keys.push(Keyframe {
            time_ms: start_ms,
            value: track.default,
            easing: Easing::EaseInOut,
        });
    }
    if let Some(k) = track.keys.iter_mut().find(|k| k.time_ms == t_ms) {
        k.value = value;
    } else {
        track.keys.push(Keyframe { time_ms: t_ms, value, easing: Easing::EaseInOut });
        track.keys.sort_by(|a, b| a.time_ms.cmp(&b.time_ms));
    }
}

/// Apply a transform edit as keyframes at `t_ms` for the given layer. This is
/// how direct manipulation on the canvas becomes animation: drag at one time,
/// drag at another, and the evaluator fills in the frames between.
#[tauri::command]
fn edit_keyframes(
    state: State<AppState>,
    layer_id: u32,
    t_ms: u32,
    edit: TransformEdit,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let start = layer.start_ms;
    let tf = &mut layer.transform;
    upsert_key(&mut tf.x, t_ms, edit.x, seed_start, start);
    upsert_key(&mut tf.y, t_ms, edit.y, seed_start, start);
    upsert_key(&mut tf.scale_x, t_ms, edit.scale_x, seed_start, start);
    upsert_key(&mut tf.scale_y, t_ms, edit.scale_y, seed_start, start);
    upsert_key(&mut tf.rotation, t_ms, edit.rotation, seed_start, start);
    upsert_key(&mut tf.opacity, t_ms, edit.opacity, seed_start, start);
    Ok(project.clone())
}

/// Set the composition resolution (workspace size — landscape/portrait/square).
/// Layers keep their positions. Undoable.
#[tauri::command]
fn set_comp_size(state: State<AppState>, width: u32, height: u32) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    project.width = width.clamp(16, 8192);
    project.height = height.clamp(16, 8192);
    project.clone()
}

/// Set the composition frame rate (fps) — the rate the video renders at.
/// Clamped to a sane range. Undoable.
#[tauri::command]
fn set_comp_fps(state: State<AppState>, fps: f32) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    project.fps = fps.clamp(1.0, 240.0);
    project.clone()
}

/// Set the composition length (ms). Any layer whose range runs past the new end
/// is trimmed to fit (so blocks stay inside the timeline). Undoable.
#[tauri::command]
fn set_comp_duration(state: State<AppState>, duration_ms: u32) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let dur = duration_ms.clamp(MIN_SPAN_MS, 3_600_000);
    project.duration_ms = dur;
    for l in &mut project.layers {
        if l.end_ms > dur {
            l.end_ms = dur;
        }
        if l.start_ms + MIN_SPAN_MS > l.end_ms {
            l.start_ms = l.end_ms.saturating_sub(MIN_SPAN_MS);
        }
    }
    project.clone()
}

/// Set one layer's play range [start_ms, end_ms] (comp ms) — i.e. when on the
/// timeline it appears. Clamped to the comp and to a minimum span so it can't
/// invert or vanish. Undoable.
#[tauri::command]
fn set_layer_range(
    state: State<AppState>,
    layer_id: u32,
    start_ms: u32,
    end_ms: u32,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let dur = project.duration_ms.max(MIN_SPAN_MS);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let old_start = layer.start_ms;
    let old_end = layer.end_ms;
    // End first (capped to the comp), then start kept at least MIN_SPAN behind it.
    let mut e = end_ms.min(dur);
    let mut s = start_ms.min(e.saturating_sub(MIN_SPAN_MS));
    if e < s + MIN_SPAN_MS {
        e = (s + MIN_SPAN_MS).min(dur);
        s = e.saturating_sub(MIN_SPAN_MS);
    }
    // Keyframes stick to the layer: a pure MOVE (span preserved) shifts every
    // keyframe by the same delta, so they travel with the block. A trim (span
    // changed) leaves them put. The per-letter animation start is now anchored
    // to the layer's start (see eval::letter_at), so it moves automatically and
    // must NOT be shifted here — doing so would double-count the offset.
    let delta = s as i64 - old_start as i64;
    let span_preserved = (e as i64 - s as i64) == (old_end as i64 - old_start as i64);
    if span_preserved && delta != 0 {
        for_each_track_mut(layer, |tr| {
            for k in tr.keys.iter_mut() {
                k.time_ms = (k.time_ms as i64 + delta).max(0) as u32;
            }
        });
        // A group carries its contents: moving it shifts every child's timing
        // (ranges + keyframes) by the same delta, recursively.
        if let LayerKind::Group { children } = &mut layer.kind {
            for c in children.iter_mut() {
                shift_layer_time(c, delta);
            }
        }
    }
    layer.start_ms = s;
    layer.end_ms = e;
    Ok(project.clone())
}

/// Retime a keyframe: move every key sitting at `from_ms` (one timeline diamond,
/// which is all of a layer's tracks that share that time) to `to_ms`. Only tracks
/// that actually have a key at `from_ms` are touched; any existing key at the
/// destination on those tracks is replaced. Clamped to the comp. Undoable.
#[tauri::command]
fn move_keyframes_at(
    state: State<AppState>,
    layer_id: u32,
    from_ms: u32,
    to_ms: u32,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    let dur = project.duration_ms;
    state.snapshot(&project);
    let to = to_ms.min(dur);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    if to == from_ms {
        return Ok(project.clone());
    }
    for_each_track_mut(layer, |tr| {
        if !tr.keys.iter().any(|k| k.time_ms == from_ms) {
            return;
        }
        // Drop any key already at the destination so we don't end up with two.
        tr.keys.retain(|k| k.time_ms != to);
        for k in tr.keys.iter_mut() {
            if k.time_ms == from_ms {
                k.time_ms = to;
            }
        }
        tr.keys.sort_by(|a, b| a.time_ms.cmp(&b.time_ms));
    });
    Ok(project.clone())
}

/// Set (or clear) a layer's in/out transition. `slot` is "in" or "out"; `kind`
/// is "none" (clear), "dissolve", "slide", or "wipe". `direction` (0=left,
/// 1=right,2=up,3=down) is used by slide/wipe. Undoable.
#[tauri::command]
fn set_layer_transition(
    state: State<AppState>,
    layer_id: u32,
    slot: String,
    kind: String,
    dur_ms: u32,
    direction: u8,
    engine: Option<String>,
    params: Option<String>,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let transition = if kind == "none" {
        None
    } else if let Some(id) = engine.filter(|s| !s.is_empty()) {
        // Any transition-engine effect; `kind` is kept only as a legacy fallback.
        Some(Transition { kind: TransitionKind::Dissolve, dur_ms, direction, engine: Some(id), params })
    } else {
        match kind.as_str() {
            "dissolve" => Some(Transition { kind: TransitionKind::Dissolve, dur_ms, direction, engine: None, params: None }),
            "slide" => Some(Transition { kind: TransitionKind::Slide, dur_ms, direction, engine: None, params: None }),
            "wipe" => Some(Transition { kind: TransitionKind::Wipe, dur_ms, direction, engine: None, params: None }),
            _ => return Err("unknown transition kind".into()),
        }
    };
    match slot.as_str() {
        "in" => layer.transition_in = transition,
        "out" => layer.transition_out = transition,
        _ => return Err("slot must be \"in\" or \"out\"".into()),
    }
    Ok(project.clone())
}

/// Reorder the layer stack (z-order). `order` is the full list of layer ids in
/// the new draw order: index 0 is the bottom layer, the last is drawn on top.
/// Must be a permutation of the current ids. Undoable.
#[tauri::command]
fn reorder_layers(state: State<AppState>, order: Vec<u32>) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    // Guard: the new order must contain exactly the same ids, no more, no less.
    let mut have: Vec<u32> = project.layers.iter().map(|l| l.id).collect();
    let mut want = order.clone();
    have.sort_unstable();
    want.sort_unstable();
    if have != want {
        return Err("order must be a permutation of the existing layer ids".into());
    }
    state.snapshot(&project);
    let mut by_id: HashMap<u32, Layer> = project.layers.drain(..).map(|l| (l.id, l)).collect();
    project.layers = order.iter().filter_map(|id| by_id.remove(id)).collect();
    Ok(project.clone())
}

/// Place a just-added layer: move its play range to start at `start_ms` (keeping
/// its span, clamped to the comp) and slot it directly ABOVE `above_id` in the
/// stack (last = top). `above_id` = None leaves it on top. One undo step — the
/// caller runs this right after an add so the two read as a single action.
#[tauri::command]
fn place_layer(
    state: State<AppState>,
    layer_id: u32,
    start_ms: u32,
    above_id: Option<u32>,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    let dur = project.duration_ms.max(MIN_SPAN_MS);
    // Re-time: start at the playhead, keep the span, clamp to the comp end.
    {
        let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
        let span = layer.end_ms.saturating_sub(layer.start_ms).max(MIN_SPAN_MS);
        let s = start_ms.min(dur.saturating_sub(MIN_SPAN_MS));
        let e = (s + span).min(dur);
        layer.start_ms = s.min(e.saturating_sub(MIN_SPAN_MS));
        layer.end_ms = e;
    }
    // Re-stack: pull the layer out and reinsert just above `above_id`.
    if let Some(from) = project.layers.iter().position(|l| l.id == layer_id) {
        let layer = project.layers.remove(from);
        let insert_at = match above_id.and_then(|aid| project.layers.iter().position(|l| l.id == aid)) {
            Some(ai) => ai + 1, // directly above the reference layer
            None => project.layers.len(), // top
        };
        project.layers.insert(insert_at, layer);
    }
    Ok(project.clone())
}

/// Combine the given layers (current scope) into one `Group` (precomp). Members
/// are removed from the scope and nested into a new group placed where the
/// top-most member was; the group spans the union of their play ranges. The
/// group's own transform is identity, so children keep their on-screen positions.
/// Returns the new group's id via the top layer. Undoable.
#[tauri::command]
fn combine_layers(state: State<AppState>, ids: Vec<u32>) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    // Keep members in their current stacking order (bottom-first).
    let members: Vec<usize> = project
        .layers
        .iter()
        .enumerate()
        .filter(|(_, l)| ids.contains(&l.id))
        .map(|(i, _)| i)
        .collect();
    if members.len() < 2 {
        return Err("select at least two layers to combine".into());
    }
    state.snapshot(&project);
    let top_pos = *members.last().unwrap();
    let (mut start_ms, mut end_ms) = (u32::MAX, 0u32);
    // Remove from the top down so earlier indices stay valid; collect in order.
    let mut taken: Vec<Layer> = Vec::with_capacity(members.len());
    for &i in members.iter().rev() {
        let l = project.layers.remove(i);
        start_ms = start_ms.min(l.start_ms);
        end_ms = end_ms.max(l.end_ms);
        taken.push(l);
    }
    taken.reverse(); // back to bottom-first
    // How many removed layers sat below the top member → the insert index.
    let below = members.iter().filter(|&&i| i < top_pos).count();
    let insert_at = top_pos - below;
    let next_id = max_layer_id(&project.layers).max(taken.iter().map(|l| l.id).max().unwrap_or(0)) + 1;
    let group = Layer {
        id: next_id,
        name: "Group".into(),
        start_ms: start_ms.min(end_ms.saturating_sub(MIN_SPAN_MS)),
        end_ms,
        kind: LayerKind::Group { children: taken },
        transform: Transform::at(0.0, 0.0),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    };
    project.layers.insert(insert_at, group);
    Ok(project.clone())
}

/// Explode (ungroup) a `Group`, lifting its children back into the current scope
/// where the group sat (preserving their order). Undoable.
#[tauri::command]
fn explode_layer(state: State<AppState>, group_id: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    let idx = project.layers.iter().position(|l| l.id == group_id).ok_or("group not found")?;
    let children = match &project.layers[idx].kind {
        LayerKind::Group { children } => children.clone(),
        _ => return Err("not a group".into()),
    };
    state.snapshot(&project);
    project.layers.remove(idx);
    for (k, child) in children.into_iter().enumerate() {
        project.layers.insert(idx + k, child);
    }
    Ok(project.clone())
}

/// Enter a group to edit its children on their own timeline. Swaps the current
/// scope to the group's children (so every editing command operates on them
/// unchanged); `exit_group` re-nests the edits. Clears undo (scopes don't share
/// history). Returns the child scope.
#[tauri::command]
fn enter_group(state: State<AppState>, group_id: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    let idx = project.layers.iter().position(|l| l.id == group_id).ok_or("group not found")?;
    let children = match &mut project.layers[idx].kind {
        LayerKind::Group { children } => std::mem::take(children),
        _ => return Err("not a group".into()),
    };
    let parent = std::mem::replace(&mut project.layers, children);
    state.nav.lock().unwrap().push(NavFrame { parent_layers: parent, group_id });
    let mut h = state.history.lock().unwrap();
    h.undo.clear();
    h.redo.clear();
    Ok(project.clone())
}

/// Leave the current group, re-nesting the edited children back into it and
/// restoring the parent scope. Clears undo. Returns the parent scope. No-op error
/// if not inside a group.
#[tauri::command]
fn exit_group(state: State<AppState>) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    let frame = state.nav.lock().unwrap().pop().ok_or("not inside a group")?;
    let edited = std::mem::replace(&mut project.layers, frame.parent_layers);
    if let Some(l) = project.layers.iter_mut().find(|l| l.id == frame.group_id) {
        if let LayerKind::Group { children } = &mut l.kind {
            *children = edited;
        }
    }
    let mut h = state.history.lock().unwrap();
    h.undo.clear();
    h.redo.clear();
    Ok(project.clone())
}

/// How many groups deep the editing scope currently is (0 = root comp).
#[tauri::command]
fn nav_depth(state: State<AppState>) -> usize {
    state.nav.lock().unwrap().len()
}

/// Give `layer` (and any nested group children) fresh unique ids from `next` —
/// used when cloning so a duplicated group's children don't collide with the
/// originals.
fn reassign_ids(layer: &mut Layer, next: &mut u32) {
    layer.id = *next;
    *next += 1;
    if let LayerKind::Group { children } = &mut layer.kind {
        for c in children.iter_mut() {
            reassign_ids(c, next);
        }
    }
}

/// Highest layer id anywhere in a layer list (recursing into groups) — so new ids
/// stay unique across the whole tree.
fn max_layer_id(layers: &[Layer]) -> u32 {
    layers
        .iter()
        .map(|l| {
            let child_max = match &l.kind {
                LayerKind::Group { children } => max_layer_id(children),
                _ => 0,
            };
            l.id.max(child_max)
        })
        .max()
        .unwrap_or(0)
}

/// Save the current project to `path` as a Simple Effects (.sefx) file — pretty
/// JSON of the whole project, reloadable with `open_project_file`.
#[tauri::command]
fn save_project_file(state: State<AppState>, path: String) -> Result<(), String> {
    let project = state.project.lock().unwrap();
    let json = serde_json::to_string_pretty(&*project).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write {path}: {e}"))
}

/// Return (and clear) any `.sefx` path the app was launched with (e.g. the OS
/// opening an associated file by double-click). The frontend calls this once on
/// startup and, if present, opens that project instead of the blank default.
#[tauri::command]
fn take_launch_file(state: State<AppState>) -> Option<String> {
    state.launch_file.lock().unwrap().take()
}

/// Scan CLI args for the first existing `.sefx` file (the path the OS passes when
/// a double-clicked, associated file launches the app).
fn launch_file_from_args() -> Option<String> {
    std::env::args().skip(1).find(|a| {
        a.to_lowercase().ends_with(".sefx") && std::path::Path::new(a).is_file()
    })
}

/// Open a Simple Effects (.sefx) project file, replacing the current project and
/// re-shaping its text layers. Returns the loaded project. Undoable.
#[tauri::command]
fn open_project_file(state: State<AppState>, path: String) -> Result<Project, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
    let loaded: Project = serde_json::from_str(&text).map_err(|e| format!("parse {path}: {e}"))?;
    let mut current = state.project.lock().unwrap();
    state.snapshot(&current);
    let mut shaped = state.shaped.lock().unwrap();
    reshape_all(&loaded, &mut shaped);
    *current = loaded;
    Ok(current.clone())
}

/// Show/hide a layer manually (independent of its time range). Undoable.
#[tauri::command]
fn set_layer_hidden(
    state: State<AppState>,
    layer_id: u32,
    hidden: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    layer.hidden = hidden;
    Ok(project.clone())
}

/// Key one glyph's manual transform at `t_ms` (decompose mode). Each channel is
/// its own track, so dragging a letter at different playhead positions animates
/// it over time — like the whole layer's keyframes. `parts` is grown to the
/// shaped glyph count on demand. `seed_start` drops a rest keyframe at the layer
/// start when the letter isn't yet keyed, so a single edit later animates from
/// the beginning.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_letter_override(
    state: State<AppState>,
    layer_id: u32,
    index: usize,
    dx: f32,
    dy: f32,
    rotation: f32,
    scale: f32,
    t_ms: u32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let count = state
        .shaped
        .lock()
        .unwrap()
        .get(&layer_id)
        .map(|s| s.glyphs.len())
        .unwrap_or(0);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let start = layer.start_ms;
    match &mut layer.kind {
        LayerKind::Text { parts, .. } => {
            if parts.len() < count {
                parts.resize_with(count, LetterOverride::default);
            }
            if let Some(slot) = parts.get_mut(index) {
                upsert_key(&mut slot.dx, t_ms, Some(dx), seed_start, start);
                upsert_key(&mut slot.dy, t_ms, Some(dy), seed_start, start);
                upsert_key(&mut slot.rotation, t_ms, Some(rotation), seed_start, start);
                upsert_key(&mut slot.scale, t_ms, Some(scale), seed_start, start);
            }
        }
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Key one glyph's fill colour at `t_ms` (decompose mode) so each letter can be
/// coloured individually — and animated, like the layer colour. `parts` grows to
/// the shaped glyph count on demand.
#[tauri::command]
fn set_letter_color(
    state: State<AppState>,
    layer_id: u32,
    index: usize,
    color: Rgba,
    t_ms: u32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let count = state
        .shaped
        .lock()
        .unwrap()
        .get(&layer_id)
        .map(|s| s.glyphs.len())
        .unwrap_or(0);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let start = layer.start_ms;
    match &mut layer.kind {
        LayerKind::Text { color: layer_color, parts, .. } => {
            if parts.len() < count {
                parts.resize_with(count, LetterOverride::default);
            }
            if let Some(slot) = parts.get_mut(index) {
                let prev = slot.color_keys.last().map(|k| k.color).unwrap_or(*layer_color);
                upsert_color_key(&mut slot.color_keys, t_ms, color, prev, seed_start, start);
            }
        }
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Clear one glyph's manual colour keys (revert it to the layer colour).
#[tauri::command]
fn clear_letter_color(
    state: State<AppState>,
    layer_id: u32,
    index: usize,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Text { parts, .. } => {
            if let Some(slot) = parts.get_mut(index) {
                slot.color_keys.clear();
            }
        }
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Key the decompose amount (0 composed .. 1 decomposed) at `t_ms` for a text
/// layer. `seed_start=true` drops a 0-keyframe at the layer start so a single
/// "decomposed" key animates the explode from the beginning.
#[tauri::command]
fn set_decompose_key(
    state: State<AppState>,
    layer_id: u32,
    t_ms: u32,
    value: f32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let start = layer.start_ms;
    match &mut layer.kind {
        LayerKind::Text { decompose, .. } => {
            upsert_key(decompose, t_ms, Some(value), seed_start, start)
        }
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Add an invisible 3D box/cylinder object centred in the comp. Images can then
/// be pinned to it (`attach_image`) to render as decals on its surface.
#[tauri::command]
fn add_shape_layer(state: State<AppState>, shape: SurfaceShape) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let next_id = max_layer_id(&project.layers) + 1;
    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    let end_ms = default_new_layer_end(project.duration_ms);
    // A comfortable default size relative to the comp.
    let w = project.width as f32 * 0.4;
    let h = project.height as f32 * 0.4;
    let name = match shape {
        SurfaceShape::Box => "Box",
        SurfaceShape::Cylinder => "Cylinder",
    };
    project.layers.push(Layer {
        id: next_id,
        name: name.into(),
        start_ms: 0,
        end_ms,
        kind: LayerKind::Shape3D {
            shape,
            width: Track::constant(w),
            height: Track::constant(h),
            depth: Track::constant(w.min(h) * 0.7),
            rotation_x: Track::constant(0.0),
            rotation_y: Track::constant(0.0),
            rotation_z: Track::constant(0.0),
            perspective: Track::constant(0.35),
            focal_length: Track::constant(1200.0),
            coverage: Track::constant(360.0),
            radius: Track::constant(w.min(h) * 0.5),
        },
        transform: Transform::at(cx, cy),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });
    project.clone()
}

/// Add a 2D vector shape (rectangle / circle / polygon) centred in the comp,
/// sized to ~30% of it, with a plain fill (no border/glow/shadow yet). Select it
/// and style it in the inspector. Undoable.
#[tauri::command]
fn add_shape2d_layer(state: State<AppState>, shape: String) -> Result<Project, String> {
    let vs = match shape.as_str() {
        "rectangle" => VectorShape::Rectangle,
        "circle" => VectorShape::Circle,
        "polygon" => VectorShape::Polygon,
        "arrow" => VectorShape::Arrow,
        "line" => VectorShape::Line,
        _ => return Err(format!("unknown shape '{shape}'")),
    };
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let next_id = max_layer_id(&project.layers) + 1;
    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    let end_ms = default_new_layer_end(project.duration_ms);
    let size = (project.width.min(project.height) as f32) * 0.3;
    let name = match vs {
        VectorShape::Rectangle => "Rectangle",
        VectorShape::Circle => "Circle",
        VectorShape::Polygon => "Polygon",
        VectorShape::Arrow => "Arrow",
        VectorShape::Line => "Line",
    };
    project.layers.push(Layer {
        id: next_id,
        name: name.into(),
        start_ms: 0,
        end_ms,
        kind: LayerKind::Shape2D { style: Shape2DStyle::new(vs, size) },
        transform: Transform::at(cx, cy),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });
    Ok(project.clone())
}

/// Size a carousel cylinder to fill the frame with no empty space: the height
/// matches the comp height, and the radius makes `n` frame-aspect images tile the
/// full 360° so they sit seamlessly and the front image spans the frame. Floored
/// so the cylinder always spans the frame width, even with only a couple images.
fn carousel_dims(cw: f32, ch: f32, n: u32) -> (f32, f32) {
    let radius = ((n.max(1) as f32 * cw) / (2.0 * std::f32::consts::PI)).max(cw * 0.6);
    (radius, ch)
}

/// Template: build a rotating "cylinder carousel" from a set of images. Creates a
/// cylinder and pins each image as a decal evenly spaced around it, then keyframes
/// the cylinder's Y-rotation to SNAP from one image to the next — rotate to an
/// image, hold for `pause_ms`, rotate to the next over `rotate_ms` — looping
/// seamlessly (a full 360° over all N images). Optionally fades each image in/out
/// with a transition `engine`. Sizes to the comp; extends the comp duration to fit
/// one full loop. Undoable.
#[tauri::command]
fn create_cylinder_carousel(
    state: State<AppState>,
    images: Vec<String>,
    pause_ms: u32,
    rotate_ms: u32,
    transition: Option<String>,
) -> Result<Project, String> {
    let n = images.len();
    if n == 0 {
        return Err("pick at least one image".into());
    }
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);

    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    let (radius, height) = carousel_dims(project.width as f32, project.height as f32, n as u32);

    let cycle = (rotate_ms + pause_ms).max(1);
    let total = cycle * n as u32; // one full loop back to the first image
    let step = 360.0 / n as f32; // angular spacing between images
    // Front-facing Y-rotation for image i (decal at u = (i+0.5)/n). The surface
    // angle of a decal at u is (-180 + u*360)°; the rotation that brings it to the
    // front (angle 0) is its negation. Image 0 sits at u = 0.5/n.
    let front_ry = |i: usize| 180.0 - step * (i as f32 + 0.5);

    // Snap keyframes: for each image, arrive → hold (pause) → ease-rotate to next.
    let mut keys = Vec::with_capacity(2 * n + 1);
    for i in 0..=n {
        let angle = front_ry(0) - step * i as f32; // keep rotating one way (seamless loop)
        let t_arrive = cycle * i as u32;
        // Arrival key — its segment to the hold key is flat (same value).
        keys.push(Keyframe { time_ms: t_arrive, value: angle, easing: Easing::Linear });
        if i < n {
            // Hold key — its segment eases the rotation to the next image.
            keys.push(Keyframe {
                time_ms: t_arrive + pause_ms,
                value: angle,
                easing: Easing::EaseInOut,
            });
        }
    }
    let rotation_y = Track { keys, default: front_ry(0) };

    let base_id = max_layer_id(&project.layers);
    let cyl_id = base_id + 1;
    project.layers.push(Layer {
        id: cyl_id,
        name: "Carousel".into(),
        start_ms: 0,
        end_ms: total,
        kind: LayerKind::Shape3D {
            shape: SurfaceShape::Cylinder,
            width: Track::constant(radius * 2.0),
            height: Track::constant(height),
            depth: Track::constant(radius * 2.0),
            rotation_x: Track::constant(0.0),
            rotation_y,
            rotation_z: Track::constant(0.0),
            perspective: Track::constant(0.35),
            focal_length: Track::constant(1200.0),
            coverage: Track::constant(360.0),
            radius: Track::constant(radius),
        },
        transform: Transform::at(cx, cy),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });

    // Each image: an Image layer pinned to the cylinder as a decal at its slot.
    let mk_fade = |eng: &str| Transition {
        kind: TransitionKind::Dissolve,
        dur_ms: 600,
        direction: 0,
        engine: Some(eng.to_string()),
        params: None,
    };
    for (i, path) in images.iter().enumerate() {
        let (iw, ih) = image::image_dimensions(path).unwrap_or((1, 1));
        let name = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("Image {}", i + 1));
        let u = (i as f32 + 0.5) / n as f32;
        // Cover-crop to the frame aspect so the panels are uniform, fill the frame,
        // and tile the cylinder seamlessly.
        let (crop, _) = cover_crop(iw.max(1) as f32, ih.max(1) as f32, project.width as f32, project.height as f32);
        let (tin, tout) = match &transition {
            Some(eng) => (Some(mk_fade(eng)), Some(mk_fade(eng))),
            None => (None, None),
        };
        project.layers.push(Layer {
            id: cyl_id + 1 + i as u32,
            name,
            start_ms: 0,
            end_ms: total,
            kind: LayerKind::Image { src: path.clone(), width: iw.max(1), height: ih.max(1), crop: Some(crop) },
            transform: Transform::at(cx, cy),
            hidden: false,
            attach: Some(Decal {
                shape_id: cyl_id,
                face: 0,
                u: Track::constant(u),
                v: Track::constant(0.5),
                scale: Track::constant(1.0),
                rotation: Track::constant(0.0),
            }),
            effects: vec![],
            transition_in: tin,
            transition_out: tout,
        });
    }

    // Make sure the comp is long enough to show one full loop.
    if project.duration_ms < total {
        project.duration_ms = total;
    }
    Ok(project.clone())
}

/// Template: build a rotating cube carousel. Images sit on the box's four side
/// faces (front/right/back/left in rotation order); the cube snaps 90° per image,
/// holding on each. With more than four images the faces cycle — each image lives
/// on its face only while that face is on/near the front, swapping to the next
/// image for that face while the face is turned to the back (culled), so the swap
/// is invisible. The first/last image optionally fade the whole cube in/out.
/// Extends the comp to fit. Undoable.
#[tauri::command]
fn create_box_carousel(
    state: State<AppState>,
    images: Vec<String>,
    pause_ms: u32,
    rotate_ms: u32,
    transition: Option<String>,
) -> Result<Project, String> {
    let n = images.len();
    if n == 0 {
        return Err("pick at least one image".into());
    }
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);

    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    let comp_min = project.width.min(project.height) as f32;
    let side = comp_min * 0.5; // cube edge

    let cycle = (rotate_ms + pause_ms).max(1);
    // Sequence: hold image 0, rotate to 1, hold, … arrive on the last and hold
    // (no wrap). One "step" spans `cycle`; the final step has no outgoing rotate.
    let total = (n as u32 - 1) * cycle + pause_ms;

    // Rotation about Y: −90° per step (one consistent direction), snapping. The
    // engine adds rotation_y to a face's intrinsic angle (front at 0), so at step
    // i the face whose angle ≡ 90·i is brought to the front.
    let mut keys = Vec::with_capacity(2 * n);
    for i in 0..n {
        let angle = -90.0 * i as f32;
        let t_arrive = i as u32 * cycle;
        keys.push(Keyframe { time_ms: t_arrive, value: angle, easing: Easing::Linear });
        if i + 1 < n {
            // Hold key — its segment eases the rotation to the next face.
            keys.push(Keyframe {
                time_ms: t_arrive + pause_ms,
                value: angle,
                easing: Easing::EaseInOut,
            });
        }
    }
    let rotation_y = Track { keys, default: 0.0 };

    let base_id = max_layer_id(&project.layers);
    let box_id = base_id + 1;
    project.layers.push(Layer {
        id: box_id,
        name: "Cube".into(),
        start_ms: 0,
        end_ms: total,
        kind: LayerKind::Shape3D {
            shape: SurfaceShape::Box,
            width: Track::constant(side),
            height: Track::constant(side),
            depth: Track::constant(side),
            rotation_x: Track::constant(0.0),
            rotation_y,
            rotation_z: Track::constant(0.0),
            perspective: Track::constant(0.35),
            focal_length: Track::constant(1200.0),
            coverage: Track::constant(360.0),
            radius: Track::constant(side),
        },
        transform: Transform::at(cx, cy),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });

    // Side faces in rotation order: front(0), right(3), back(1), left(2).
    const FACE_ORDER: [u32; 4] = [0, 3, 1, 2];
    let fade_dur = rotate_ms.max(300);
    let mk_fade = |eng: &str| Transition {
        kind: TransitionKind::Dissolve,
        dur_ms: fade_dur,
        direction: 0,
        engine: Some(eng.to_string()),
        params: None,
    };
    for (i, path) in images.iter().enumerate() {
        let (iw, ih) = image::image_dimensions(path).unwrap_or((1, 1));
        let name = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("Image {}", i + 1));
        let face = FACE_ORDER[i % 4];
        // Visible window: from this face's previous back-crossing to its next one
        // (the face is at the back at steps i±2), so the swap to the image sharing
        // this face happens off-screen (culled) and is invisible.
        let start_ms = ((i as i64 - 2).max(0) as u32) * cycle;
        let end_ms = (((i as u32) + 2) * cycle).min(total);
        // Only the first/last image carry a fade — they're front-facing at the
        // comp start/end, so the whole cube reads as fading in / out. The rest
        // transition via the 3D rotation itself.
        let tin = if i == 0 { transition.as_deref().map(&mk_fade) } else { None };
        let tout = if i + 1 == n { transition.as_deref().map(&mk_fade) } else { None };
        project.layers.push(Layer {
            id: box_id + 1 + i as u32,
            name,
            start_ms,
            end_ms,
            kind: LayerKind::Image { src: path.clone(), width: iw.max(1), height: ih.max(1), crop: None },
            transform: Transform::at(cx, cy),
            hidden: false,
            attach: Some(Decal {
                shape_id: box_id,
                face,
                u: Track::constant(0.5),
                v: Track::constant(0.5),
                scale: Track::constant(0.9),
                rotation: Track::constant(0.0),
            }),
            effects: vec![],
            transition_in: tin,
            transition_out: tout,
        });
    }

    if project.duration_ms < total {
        project.duration_ms = total;
    }
    Ok(project.clone())
}

/// Template: arrange `images` into a centred grid ("photo wall") that assembles
/// in — each image fades in one after another (staggered by `stagger_ms`) over
/// `fade_ms`, then holds. Auto-sizes the grid to fit the count. The images are
/// wrapped in a group so they move / scale as one unit. `hold_ms` is how long the
/// finished wall stays after the last image lands; `fade_out` breaks it back out
/// Cover-crop an image of natural size `(iw, ih)` to the aspect of a `bw×bh`
/// block: the centred source rect of that aspect, plus the uniform scale that
/// makes the crop exactly fill the block (no stretch, no blank space).
fn cover_crop(iw: f32, ih: f32, bw: f32, bh: f32) -> (CropRect, f32) {
    let aspect = (bw / bh).max(1e-6);
    let (cw, ch) = if iw / ih >= aspect {
        (ih * aspect, ih) // image is wider than the block → crop the sides
    } else {
        (iw, iw / aspect) // image is taller → crop top and bottom
    };
    let crop = CropRect { x: (iw - cw) / 2.0, y: (ih - ch) / 2.0, width: cw, height: ch };
    (crop, bw / cw)
}

/// at the end. Extends the comp to fit. Undoable.
#[tauri::command]
fn create_photo_grid(
    state: State<AppState>,
    images: Vec<String>,
    stagger_ms: u32,
    fade_ms: u32,
    hold_ms: u32,
    fade_out: bool,
) -> Result<Project, String> {
    let n = images.len();
    if n == 0 {
        return Err("pick at least one image".into());
    }
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);

    let (cw, ch) = (project.width as f32, project.height as f32);
    // Near-square layout: cols = ceil(√n), rows = ceil(n / cols).
    let cols = (n as f32).sqrt().ceil().max(1.0) as u32;
    let rows = ((n as u32) + cols - 1) / cols;

    // Fill ~88% of the comp, leaving a small gap between cells.
    let margin = 0.06f32;
    let gap = 0.04f32;
    let cell_w = cw * (1.0 - 2.0 * margin) / cols as f32;
    let cell_h = ch * (1.0 - 2.0 * margin) / rows as f32;
    let inner_w = cell_w * (1.0 - gap);
    let inner_h = cell_h * (1.0 - gap);
    let origin_x = cw * margin;
    let origin_y = ch * margin;

    // Timeline: images land every `stagger_ms`; after the last lands, hold, then
    // optionally break out over `fade_ms`.
    let last_start = (n as u32 - 1) * stagger_ms;
    let total = last_start + fade_ms + hold_ms + if fade_out { fade_ms } else { 0 };

    let mk = |eng: &str, dur: u32| Transition {
        kind: TransitionKind::Dissolve,
        dur_ms: dur,
        direction: 0,
        engine: Some(eng.to_string()),
        params: None,
    };

    // Trailing cells with no image (they sit after the last image in the last
    // row). The last image is cover-cropped to span them so there's no blank gap.
    let empties = rows * cols - n as u32;

    let base_id = max_layer_id(&project.layers);
    let group_id = base_id + 1;
    let mut children: Vec<Layer> = Vec::with_capacity(n);
    for (i, path) in images.iter().enumerate() {
        let (iw, ih) = image::image_dimensions(path).unwrap_or((1, 1));
        let (iwf, ihf) = (iw.max(1) as f32, ih.max(1) as f32);
        let name = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("Image {}", i + 1));
        let col = i as u32 % cols;
        let row = i as u32 / cols;
        let ccy = origin_y + (row as f32 + 0.5) * cell_h;

        let is_last_filler = i + 1 == n && empties > 0;
        let (px, py, sx, sy, crop) = if is_last_filler {
            // Widen this image to span its cell + the trailing empty cells in the
            // last row (as one solid block), and cover-crop it to fill without
            // stretching. The renderer keeps the crop through its fade.
            let block_left = origin_x + col as f32 * cell_w + cell_w * gap / 2.0;
            let block_right = origin_x + cols as f32 * cell_w - cell_w * gap / 2.0;
            let block_w = block_right - block_left;
            let (crop, scale) = cover_crop(iwf, ihf, block_w, inner_h);
            ((block_left + block_right) / 2.0, ccy, scale, scale, Some(crop))
        } else {
            let ccx = origin_x + (col as f32 + 0.5) * cell_w;
            let fit = (inner_w / iwf).min(inner_h / ihf); // contain in the cell
            (ccx, ccy, fit, fit, None)
        };
        // Every image (filler included) fades in, and out when `fade_out` is set.
        let tin = Some(mk("fade", fade_ms));
        let tout = if fade_out { Some(mk("fade", fade_ms)) } else { None };
        let mut tf = Transform::at(px, py);
        tf.scale_x = Track::constant(sx);
        tf.scale_y = Track::constant(sy);
        children.push(Layer {
            id: group_id + 1 + i as u32,
            name,
            start_ms: i as u32 * stagger_ms,
            end_ms: total,
            kind: LayerKind::Image { src: path.clone(), width: iw.max(1), height: ih.max(1), crop },
            transform: tf,
            hidden: false,
            attach: None,
            effects: vec![],
            transition_in: tin,
            transition_out: tout,
        });
    }

    project.layers.push(Layer {
        id: group_id,
        name: format!("Photo grid {cols}×{rows}"),
        start_ms: 0,
        end_ms: total,
        kind: LayerKind::Group { children },
        transform: Transform::at(0.0, 0.0),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });

    if project.duration_ms < total {
        project.duration_ms = total;
    }
    Ok(project.clone())
}

/// Template "Grid call": images are introduced one at a time — each appears large
/// at the centre, holds, then shrinks and slides into its grid cell — until the
/// whole grid is built. Once every image is seated, the assembled grid zooms out
/// a little and springs back to size. The images live in a group centred on the
/// comp so the closing zoom scales the whole wall about its centre. Undoable.
#[tauri::command]
fn create_grid_call(
    state: State<AppState>,
    images: Vec<String>,
    hold_ms: u32,        // how long each image stays large at centre
    shrink_ms: u32,      // how long the shrink-and-slide to its cell takes
    bounce_ms: u32,      // closing zoom-out / zoom-back, each direction (0 = none)
    final_hold_ms: u32,  // how long the finished grid holds at the end
) -> Result<Project, String> {
    let n = images.len();
    if n == 0 {
        return Err("pick at least one image".into());
    }
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);

    let (cw, ch) = (project.width as f32, project.height as f32);
    let (cx, cy) = (cw / 2.0, ch / 2.0);
    // Near-square layout: cols = ceil(√n), rows = ceil(n / cols).
    let cols = (n as f32).sqrt().ceil().max(1.0) as u32;
    let rows = ((n as u32) + cols - 1) / cols;

    let margin = 0.06f32;
    let gap = 0.04f32;
    let cell_w = cw * (1.0 - 2.0 * margin) / cols as f32;
    let cell_h = ch * (1.0 - 2.0 * margin) / rows as f32;
    let inner_w = cell_w * (1.0 - gap);
    let inner_h = cell_h * (1.0 - gap);
    let origin_x = cw * margin;
    let origin_y = ch * margin;

    let shrink = shrink_ms.max(1);
    let step = hold_ms + shrink; // one image's whole intro
    let t_all = n as u32 * step; // moment the last image is seated
    let total = t_all + if bounce_ms > 0 { 2 * bounce_ms } else { 0 } + final_hold_ms;
    // Trailing empty cells the last image is cover-cropped to fill (no blank gap).
    let empties = rows * cols - n as u32;

    let base_id = max_layer_id(&project.layers);
    let group_id = base_id + 1;
    let mut children: Vec<Layer> = Vec::with_capacity(n);
    for (i, path) in images.iter().enumerate() {
        let (iw, ih) = image::image_dimensions(path).unwrap_or((1, 1));
        let (iwf, ihf) = (iw.max(1) as f32, ih.max(1) as f32);
        let name = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("Image {}", i + 1));
        let col = i as u32 % cols;
        let row = i as u32 / cols;
        // Seated cell offset (from the comp centre, the group's origin, so the
        // closing zoom scales about the centre), the big-at-centre scale, the
        // seated scale, an optional cover-crop, and the intro fade.
        let is_last_filler = i + 1 == n && empties > 0;
        let (lx, ly, big_scale, cell_scale, crop) = if is_last_filler {
            // Widen the last image over the trailing empty cells (one solid block)
            // and cover-crop it. The renderer keeps the crop through its fade.
            let block_left = origin_x + col as f32 * cell_w + cell_w * gap / 2.0;
            let block_right = origin_x + cols as f32 * cell_w - cell_w * gap / 2.0;
            let block_cx = (block_left + block_right) / 2.0;
            let block_cy = origin_y + (row as f32 + 0.5) * cell_h;
            let (crop, scale) = cover_crop(iwf, ihf, block_right - block_left, inner_h);
            // Big-at-centre scale from the CROPPED size, so it still fills ~90%.
            let big = (cw * 0.9 / crop.width).min(ch * 0.9 / crop.height);
            (block_cx - cx, block_cy - cy, big, scale, Some(crop))
        } else {
            let lx = (origin_x + (col as f32 + 0.5) * cell_w) - cx;
            let ly = (origin_y + (row as f32 + 0.5) * cell_h) - cy;
            let big = (cw * 0.9 / iwf).min(ch * 0.9 / ihf); // fills ~90% of the comp
            let cell = (inner_w / iwf).min(inner_h / ihf); // contained in its cell
            (lx, ly, big, cell, None)
        };
        // A short fade so each image eases in (the crop is preserved through it).
        let tin = Some(Transition {
            kind: TransitionKind::Dissolve,
            dur_ms: 250,
            direction: 0,
            engine: Some("fade".into()),
            params: None,
        });

        let t0 = i as u32 * step; // this image appears
        let t_hold_end = t0 + hold_ms; // begins shrinking
        let t_seated = t0 + step; // arrives in its cell

        // Position/scale keyframes: hold big at centre, then ease into the cell.
        let mut xk = vec![Keyframe { time_ms: t0, value: 0.0, easing: Easing::Linear }];
        let mut yk = vec![Keyframe { time_ms: t0, value: 0.0, easing: Easing::Linear }];
        let mut sk = vec![Keyframe { time_ms: t0, value: big_scale, easing: Easing::Linear }];
        if hold_ms > 0 {
            xk.push(Keyframe { time_ms: t_hold_end, value: 0.0, easing: Easing::EaseInOut });
            yk.push(Keyframe { time_ms: t_hold_end, value: 0.0, easing: Easing::EaseInOut });
            sk.push(Keyframe { time_ms: t_hold_end, value: big_scale, easing: Easing::EaseInOut });
        }
        xk.push(Keyframe { time_ms: t_seated, value: lx, easing: Easing::Linear });
        yk.push(Keyframe { time_ms: t_seated, value: ly, easing: Easing::Linear });
        sk.push(Keyframe { time_ms: t_seated, value: cell_scale, easing: Easing::Linear });

        let mut tf = Transform::at(0.0, 0.0);
        tf.x = Track { keys: xk, default: lx };
        tf.y = Track { keys: yk, default: ly };
        tf.scale_x = Track { keys: sk.clone(), default: cell_scale };
        tf.scale_y = Track { keys: sk, default: cell_scale };

        children.push(Layer {
            id: group_id + 1 + i as u32,
            name,
            start_ms: t0,
            end_ms: total,
            kind: LayerKind::Image { src: path.clone(), width: iw.max(1), height: ih.max(1), crop },
            transform: tf,
            hidden: false,
            attach: None,
            effects: vec![],
            // A short fade so each image eases in rather than hard-popping (the
            // cover-cropped filler uses the plain node, so it carries no fade).
            transition_in: tin,
            transition_out: None,
        });
    }

    // The group is centred on the comp; its scale stays 1 during assembly, then
    // dips and springs back once every image is seated (the closing zoom).
    let mut gtf = Transform::at(cx, cy);
    if bounce_ms > 0 {
        let scale = Track {
            keys: vec![
                Keyframe { time_ms: 0, value: 1.0, easing: Easing::Linear },
                Keyframe { time_ms: t_all, value: 1.0, easing: Easing::EaseInOut },
                Keyframe { time_ms: t_all + bounce_ms, value: 0.88, easing: Easing::EaseInOut },
                Keyframe { time_ms: t_all + 2 * bounce_ms, value: 1.0, easing: Easing::EaseOut },
            ],
            default: 1.0,
        };
        gtf.scale_x = scale.clone();
        gtf.scale_y = scale;
    }

    project.layers.push(Layer {
        id: group_id,
        name: format!("Grid call {cols}×{rows}"),
        start_ms: 0,
        end_ms: total,
        kind: LayerKind::Group { children },
        transform: gtf,
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });

    if project.duration_ms < total {
        project.duration_ms = total;
    }
    Ok(project.clone())
}

/// One slideshow-template look: which transitions cycle between slides, the Ken
/// Burns zoom range + pan, the caption styling and entrance, and a whole-video
/// colour grade (adjustment-layer filter effects).
struct SlideStyle {
    transitions: Vec<&'static str>,
    dur: u32,
    zoom0: f32,
    zoom1: f32,
    pan: f32,          // horizontal drift, fraction of comp width
    text_weight: u16,
    text_rel: f32,     // caption size as a fraction of comp height
    text_rise: f32,    // vertical entrance offset, fraction of comp height (0 = none)
    text_slide: f32,   // horizontal entrance offset, fraction of comp width (0 = none)
    grade: Vec<Effect>, // whole-video adjustment-layer grade (filter effects)
}

fn slide_style(style: &str) -> SlideStyle {
    let c = |a: f32| Effect::Contrast { amount: Track::constant(a) };
    let s = |a: f32| Effect::Saturate { amount: Track::constant(a) };
    match style {
        "dynamic" => SlideStyle {
            transitions: vec!["slide", "zoomIn", "horizontalWipe", "whipPan"],
            dur: 700,
            zoom0: 1.08,
            zoom1: 1.14,
            pan: 0.0,
            text_weight: 800,
            text_rel: 0.075,
            text_rise: 0.0,
            text_slide: 0.06,
            grade: vec![s(1.18)],
        },
        "energetic" => SlideStyle {
            transitions: vec!["glitch", "zoomIn", "shatter", "whipPan"],
            dur: 600,
            zoom0: 1.1,
            zoom1: 1.2,
            pan: 0.0,
            text_weight: 800,
            text_rel: 0.08,
            text_rise: 0.03,
            text_slide: 0.0,
            grade: vec![c(1.15), s(1.25)],
        },
        "elegant" => SlideStyle {
            transitions: vec!["fade"],
            dur: 1300,
            zoom0: 1.05,
            zoom1: 1.14,
            pan: 0.015,
            text_weight: 300,
            text_rel: 0.06,
            text_rise: 0.03,
            text_slide: 0.0,
            grade: vec![s(0.95), c(1.03)],
        },
        // "cinematic" (default)
        _ => SlideStyle {
            transitions: vec!["crossDissolve"],
            dur: 1100,
            zoom0: 1.06,
            zoom1: 1.18,
            pan: 0.02,
            text_weight: 600,
            text_rel: 0.055,
            text_rise: 0.04,
            text_slide: 0.0,
            grade: vec![c(1.08), s(1.12)],
        },
    }
}

/// A two-key ramp track at absolute comp times (`t0`→`t1`), the first key
/// carrying the segment's easing.
fn ramp2(t0: u32, v0: f32, t1: u32, v1: f32, e: Easing) -> Track {
    Track {
        keys: vec![
            Keyframe { time_ms: t0, value: v0, easing: e },
            Keyframe { time_ms: t1.max(t0 + 1), value: v1, easing: Easing::Linear },
        ],
        default: v0,
    }
}

/// Template: build a complete ~`total_ms` slideshow video from `images` (with
/// optional per-image `captions`), using the chosen `style`'s combination of
/// transitions, Ken Burns motion, a coherent colour grade, and captions that
/// fade + slide in and out. Appends all the layers and extends the comp to fit.
/// Undoable.
#[tauri::command]
fn create_slideshow_template(
    state: State<AppState>,
    images: Vec<String>,
    captions: Vec<String>,
    style: String,
    total_ms: u32,
) -> Result<Project, String> {
    let n = images.len();
    if n < 2 {
        return Err("pick at least two images".into());
    }
    let cfg = slide_style(&style);
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);

    let (cw, ch) = (project.width as f32, project.height as f32);
    let (cx, cy) = (cw / 2.0, ch / 2.0);
    let total = total_ms.max(2000);
    let per = (total / n as u32).max(cfg.dur + 600); // each slide's base span
    let total = per * n as u32; // recompute so slides tile exactly

    let mk_tr = |engine: &str, dur: u32| Transition {
        kind: TransitionKind::Dissolve,
        dur_ms: dur,
        direction: 0,
        engine: Some(engine.to_string()),
        params: None,
    };

    let base_id = max_layer_id(&project.layers);
    let mut next = base_id + 1;

    // --- Image slides: cover the frame, Ken Burns, cross-transition in. --------
    for (i, path) in images.iter().enumerate() {
        let (iw, ih) = image::image_dimensions(path).unwrap_or((1, 1));
        let (iwf, ihf) = (iw.max(1) as f32, ih.max(1) as f32);
        let name = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("Slide {}", i + 1));
        let cover = (cw / iwf).max(ch / ihf); // fill the frame (crop overflow)
        let start = i as u32 * per;
        // Overlap the next slide by the transition duration so it cross-transitions.
        let end = if i + 1 < n { (i as u32 + 1) * per + cfg.dur } else { total };
        // Ken Burns: steady zoom over the slide, with a gentle alternating pan.
        let dir = if i % 2 == 0 { 1.0 } else { -1.0 };
        let px = cfg.pan * cw * 0.5 * dir;
        let mut tf = Transform::at(cx, cy);
        tf.scale_x = ramp2(start, cover * cfg.zoom0, end, cover * cfg.zoom1, Easing::Linear);
        tf.scale_y = ramp2(start, cover * cfg.zoom0, end, cover * cfg.zoom1, Easing::Linear);
        if cfg.pan != 0.0 {
            tf.x = ramp2(start, cx - px, end, cx + px, Easing::Linear);
        }
        let tin = if i == 0 {
            mk_tr("fade", cfg.dur)
        } else {
            mk_tr(cfg.transitions[(i - 1) % cfg.transitions.len()], cfg.dur)
        };
        let tout = if i + 1 == n { Some(mk_tr("fade", cfg.dur)) } else { None };
        project.layers.push(Layer {
            id: next,
            name,
            start_ms: start,
            end_ms: end,
            kind: LayerKind::Image { src: path.clone(), width: iw.max(1), height: ih.max(1), crop: None },
            transform: tf,
            hidden: false,
            attach: None,
            effects: vec![],
            transition_in: Some(tin),
            transition_out: tout,
        });
        next += 1;
    }

    // --- Whole-video grade: an adjustment layer over all the slides. -----------
    if !cfg.grade.is_empty() {
        project.layers.push(Layer {
            id: next,
            name: "Grade".into(),
            start_ms: 0,
            end_ms: total,
            kind: LayerKind::Adjustment {},
            transform: Transform::at(0.0, 0.0),
            hidden: false,
            attach: None,
            effects: cfg.grade.clone(),
            transition_in: None,
            transition_out: None,
        });
        next += 1;
    }

    // --- Captions: one per slide (skipped when blank), fading + sliding in/out
    //     above the grade so they stay crisp and legible (drop shadow). --------
    let size = cfg.text_rel * ch;
    for i in 0..n {
        // Default the caption to a "text here" placeholder the user can edit, and
        // pin it to the bottom-right corner (right-aligned via the shaped width).
        let cap: String = captions
            .get(i)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("text here")
            .to_string();
        let t_start = i as u32 * per + cfg.dur + 150;
        let t_end = (((i + 1) as u32) * per).saturating_sub(150).max(t_start + 600);
        let fade = 500u32.min((t_end - t_start) / 2);
        let font = Font("Vazirmatn".into());
        let shaped = text::shape(&cap, size, &font, cfg.text_weight, false);
        let base_x = cw - cw * 0.04; // right edge; the Right-aligned block extends left
        let base_y = ch - ch * 0.06 - size / 2.0;
        let mut tf = Transform::at(base_x, base_y);
        if cfg.text_slide != 0.0 {
            let off = cfg.text_slide * cw;
            tf.x = Track {
                keys: vec![
                    Keyframe { time_ms: t_start, value: base_x + off, easing: Easing::EaseOut },
                    Keyframe { time_ms: t_start + fade, value: base_x, easing: Easing::Linear },
                    Keyframe { time_ms: t_end.saturating_sub(fade), value: base_x, easing: Easing::EaseIn },
                    Keyframe { time_ms: t_end, value: base_x + off, easing: Easing::Linear },
                ],
                default: base_x,
            };
        } else if cfg.text_rise != 0.0 {
            let off = cfg.text_rise * ch;
            tf.y = Track {
                keys: vec![
                    Keyframe { time_ms: t_start, value: base_y + off, easing: Easing::EaseOut },
                    Keyframe { time_ms: t_start + fade, value: base_y, easing: Easing::Linear },
                    Keyframe { time_ms: t_end.saturating_sub(fade), value: base_y, easing: Easing::EaseIn },
                    Keyframe { time_ms: t_end, value: base_y - off, easing: Easing::Linear },
                ],
                default: base_y,
            };
        }
        let text_id = next;
        project.layers.push(Layer {
            id: text_id,
            name: format!("Caption {}", i + 1),
            start_ms: t_start,
            end_ms: t_end,
            kind: LayerKind::Text {
                content: cap.to_string(),
                size,
                align: TextAlign::Right,
                color: Rgba { r: 250, g: 250, b: 252, a: 255 },
                color_keys: vec![],
                font,
                weight: cfg.text_weight,
                italic: false,
                anim: None,
                parts: vec![],
                decompose: Track::constant(1.0),
                style: None,
                animators: vec![],
                layer_styles: Some(TextLayerStyles {
                    drop_shadow: Some(DropShadow {
                        color: Rgba { r: 0, g: 0, b: 0, a: 255 },
                        opacity: 65.0,
                        angle: 90.0,
                        distance: 4.0,
                        size: 12.0,
                    }),
                    outer_glow: None,
                    inner_glow: None,
                    bevel: None,
                    gradient: None,
                }),
                per_char_3d: false,
                per_char_rx: 0.0,
                per_char_ry: 0.0,
                per_char_spread: 0.0,
            },
            transform: tf,
            hidden: false,
            attach: None,
            effects: vec![],
            transition_in: Some(mk_tr("fade", fade)),
            transition_out: Some(mk_tr("fade", fade)),
        });
        state.shaped.lock().unwrap().insert(text_id, shaped);
        next += 1;
    }

    if project.duration_ms < total {
        project.duration_ms = total;
    }
    Ok(project.clone())
}

/// Rename `layer_id` (searches nested group children too). Blank names fall back
/// to "Layer". Undoable.
fn rename_in(layers: &mut [Layer], id: u32, name: &str) -> bool {
    for l in layers.iter_mut() {
        if l.id == id {
            l.name = name.to_string();
            return true;
        }
        if let LayerKind::Group { children } = &mut l.kind {
            if rename_in(children, id, name) {
                return true;
            }
        }
    }
    false
}

#[tauri::command]
fn rename_layer(state: State<AppState>, layer_id: u32, name: String) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let trimmed = name.trim();
    let name = if trimmed.is_empty() { "Layer" } else { trimmed };
    if rename_in(&mut project.layers, layer_id, name) {
        Ok(project.clone())
    } else {
        Err("layer not found".into())
    }
}

/// Template: build a ~`total_ms` video that spins the `images` around a cylinder
/// carousel (all images wrap around it, in order), snapping to each in turn, with
/// a bottom-right caption for each that fades in/out while its image faces the
/// camera (defaults to a "text here" placeholder). Undoable.
#[tauri::command]
fn create_carousel_video(
    state: State<AppState>,
    images: Vec<String>,
    captions: Vec<String>,
    total_ms: u32,
) -> Result<Project, String> {
    let n = images.len();
    if n < 2 {
        return Err("pick at least two images".into());
    }
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);

    let (cw, ch) = (project.width as f32, project.height as f32);
    let (cx, cy) = (cw / 2.0, ch / 2.0);
    let (radius, height) = carousel_dims(cw, ch, n as u32);

    let cycle = (total_ms / n as u32).max(800);
    let rotate = (cycle * 35 / 100).max(250);
    let pause = cycle.saturating_sub(rotate).max(200);
    let cycle = pause + rotate;
    let total = cycle * n as u32;
    let step = 360.0 / n as f32;
    let front_ry = |i: usize| 180.0 - step * (i as f32 + 0.5);

    // Snap rotation: arrive → hold on each image → ease-rotate to the next.
    let mut keys = Vec::with_capacity(2 * n + 1);
    for i in 0..=n {
        let angle = front_ry(0) - step * i as f32;
        let t_arrive = cycle * i as u32;
        keys.push(Keyframe { time_ms: t_arrive, value: angle, easing: Easing::Linear });
        if i < n {
            keys.push(Keyframe { time_ms: t_arrive + pause, value: angle, easing: Easing::EaseInOut });
        }
    }
    let rotation_y = Track { keys, default: front_ry(0) };

    let base_id = max_layer_id(&project.layers);
    let mut next = base_id + 1;
    let cyl_id = next;
    next += 1;
    project.layers.push(Layer {
        id: cyl_id,
        name: "Carousel".into(),
        start_ms: 0,
        end_ms: total,
        kind: LayerKind::Shape3D {
            shape: SurfaceShape::Cylinder,
            width: Track::constant(radius * 2.0),
            height: Track::constant(height),
            depth: Track::constant(radius * 2.0),
            rotation_x: Track::constant(0.0),
            rotation_y,
            rotation_z: Track::constant(0.0),
            perspective: Track::constant(0.35),
            focal_length: Track::constant(1200.0),
            coverage: Track::constant(360.0),
            radius: Track::constant(radius),
        },
        transform: Transform::at(cx, cy),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });

    let mk_fade = |dur: u32| Transition {
        kind: TransitionKind::Dissolve,
        dur_ms: dur,
        direction: 0,
        engine: Some("fade".into()),
        params: None,
    };
    for (i, path) in images.iter().enumerate() {
        let (iw, ih) = image::image_dimensions(path).unwrap_or((1, 1));
        let name = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("Image {}", i + 1));
        let u = (i as f32 + 0.5) / n as f32;
        let (crop, _) = cover_crop(iw.max(1) as f32, ih.max(1) as f32, cw, ch);
        project.layers.push(Layer {
            id: next,
            name,
            start_ms: 0,
            end_ms: total,
            kind: LayerKind::Image { src: path.clone(), width: iw.max(1), height: ih.max(1), crop: Some(crop) },
            transform: Transform::at(cx, cy),
            hidden: false,
            attach: Some(Decal {
                shape_id: cyl_id,
                face: 0,
                u: Track::constant(u),
                v: Track::constant(0.5),
                scale: Track::constant(1.0),
                rotation: Track::constant(0.0),
            }),
            effects: vec![],
            transition_in: Some(mk_fade(500)),
            transition_out: Some(mk_fade(500)),
        });
        next += 1;
    }

    // A bottom-right caption per image, shown while that image faces the camera.
    let size = ch * 0.05;
    for i in 0..n {
        let cap: String = captions
            .get(i)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("text here")
            .to_string();
        let font = Font("Vazirmatn".into());
        let shaped = text::shape(&cap, size, &font, 600, false);
        let base_x = cw - cw * 0.04; // right edge; the Right-aligned block extends left
        let base_y = ch - ch * 0.06 - size / 2.0;
        let t_start = cycle * i as u32 + 250;
        let t_end = (cycle * i as u32 + pause).saturating_sub(100).max(t_start + 500);
        let fade = 400u32.min((t_end - t_start) / 2);
        let text_id = next;
        next += 1;
        project.layers.push(Layer {
            id: text_id,
            name: format!("Caption {}", i + 1),
            start_ms: t_start,
            end_ms: t_end,
            kind: LayerKind::Text {
                content: cap,
                size,
                align: TextAlign::Right,
                color: Rgba { r: 250, g: 250, b: 252, a: 255 },
                color_keys: vec![],
                font,
                weight: 600,
                italic: false,
                anim: None,
                parts: vec![],
                decompose: Track::constant(1.0),
                style: None,
                animators: vec![],
                layer_styles: Some(TextLayerStyles {
                    drop_shadow: Some(DropShadow {
                        color: Rgba { r: 0, g: 0, b: 0, a: 255 },
                        opacity: 65.0,
                        angle: 90.0,
                        distance: 4.0,
                        size: 12.0,
                    }),
                    outer_glow: None,
                    inner_glow: None,
                    bevel: None,
                    gradient: None,
                }),
                per_char_3d: false,
                per_char_rx: 0.0,
                per_char_ry: 0.0,
                per_char_spread: 0.0,
            },
            transform: Transform::at(base_x, base_y),
            hidden: false,
            attach: None,
            effects: vec![],
            transition_in: Some(mk_fade(fade)),
            transition_out: Some(mk_fade(fade)),
        });
        state.shaped.lock().unwrap().insert(text_id, shaped);
    }

    if project.duration_ms < total {
        project.duration_ms = total;
    }
    Ok(project.clone())
}

// ---- Mixed-video template building blocks --------------------------------------
// Each segment builder appends its layers (and any captions to shape) at an
// absolute time offset and returns the time it ends, so segments can be chained
// with a cross-fade overlap into one coherent video.

struct VCtx {
    cw: f32,
    ch: f32,
    cx: f32,
    cy: f32,
    comp_min: f32,
}

fn v_fade(dur: u32) -> Transition {
    Transition { kind: TransitionKind::Dissolve, dur_ms: dur, direction: 0, engine: Some("fade".into()), params: None }
}
fn v_engine(name: &str, dur: u32) -> Transition {
    Transition { kind: TransitionKind::Dissolve, dur_ms: dur, direction: 0, engine: Some(name.to_string()), params: None }
}

/// A bottom-right "text here" caption over `[start, end]`.
fn v_caption(
    ctx: &VCtx,
    next_id: &mut u32,
    layers: &mut Vec<Layer>,
    caps: &mut Vec<(u32, ShapedText)>,
    start: u32,
    end: u32,
) {
    if end <= start + 300 {
        return;
    }
    let size = ctx.ch * 0.05;
    let font = Font("Vazirmatn".into());
    let shaped = text::shape_aligned("text here", size, &font, 600, false, TextAlign::Right);
    let bx = ctx.cw - ctx.cw * 0.04; // right edge; the Right-aligned block extends left
    let by = ctx.ch - ctx.ch * 0.06 - size / 2.0;
    let fade = 400u32.min((end - start) / 2);
    let id = *next_id;
    *next_id += 1;
    layers.push(Layer {
        id,
        name: "Caption".into(),
        start_ms: start,
        end_ms: end,
        kind: LayerKind::Text {
            content: "text here".into(),
            size,
            align: TextAlign::Right,
            color: Rgba { r: 250, g: 250, b: 252, a: 255 },
            color_keys: vec![],
            font,
            weight: 600,
            italic: false,
            anim: None,
            parts: vec![],
            decompose: Track::constant(1.0),
            style: None,
            animators: vec![],
            layer_styles: Some(TextLayerStyles {
                drop_shadow: Some(DropShadow { color: Rgba { r: 0, g: 0, b: 0, a: 255 }, opacity: 65.0, angle: 90.0, distance: 4.0, size: 12.0 }),
                outer_glow: None,
                inner_glow: None,
                bevel: None,
                gradient: None,
            }),
            per_char_3d: false,
            per_char_rx: 0.0,
            per_char_ry: 0.0,
            per_char_spread: 0.0,
        },
        transform: Transform::at(bx, by),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: Some(v_fade(fade)),
        transition_out: Some(v_fade(fade)),
    });
    caps.push((id, shaped));
}

/// Plain cover + Ken-Burns slideshow over `[start, start+dur]`, cross-dissolving
/// between slides, with a caption per slide. Returns the segment end time.
fn v_plain_segment(
    ctx: &VCtx,
    images: &[String],
    start: u32,
    dur: u32,
    xfade: u32,
    next_id: &mut u32,
    layers: &mut Vec<Layer>,
    caps: &mut Vec<(u32, ShapedText)>,
) -> u32 {
    let n = images.len() as u32;
    if n == 0 {
        return start;
    }
    let per = (dur / n).max(xfade + 400);
    for (i, path) in images.iter().enumerate() {
        let iu = i as u32;
        let (iw, ih) = image::image_dimensions(path).unwrap_or((1, 1));
        let (iwf, ihf) = (iw.max(1) as f32, ih.max(1) as f32);
        let cover = (ctx.cw / iwf).max(ctx.ch / ihf);
        let s0 = start + iu * per;
        let s1 = if iu + 1 < n { start + (iu + 1) * per + xfade } else { start + n * per };
        let dir = if i % 2 == 0 { 1.0 } else { -1.0 };
        let px = 0.01 * ctx.cw * dir;
        let mut tf = Transform::at(ctx.cx, ctx.cy);
        tf.scale_x = ramp2(s0, cover * 1.06, s1, cover * 1.14, Easing::Linear);
        tf.scale_y = ramp2(s0, cover * 1.06, s1, cover * 1.14, Easing::Linear);
        tf.x = ramp2(s0, ctx.cx - px, s1, ctx.cx + px, Easing::Linear);
        let tin = if i == 0 { v_fade(xfade) } else { v_engine("crossDissolve", xfade) };
        let tout = if iu + 1 == n { Some(v_fade(xfade)) } else { None };
        let id = *next_id;
        *next_id += 1;
        layers.push(Layer {
            id,
            name: format!("Slide {}", i + 1),
            start_ms: s0,
            end_ms: s1,
            kind: LayerKind::Image { src: path.clone(), width: iw.max(1), height: ih.max(1), crop: None },
            transform: tf,
            hidden: false,
            attach: None,
            effects: vec![],
            transition_in: Some(tin),
            transition_out: tout,
        });
        let c0 = s0 + xfade + 100;
        let c1 = (start + (iu + 1) * per).saturating_sub(100).max(c0 + 500);
        v_caption(ctx, next_id, layers, caps, c0, c1);
    }
    start + n * per
}

/// Cylinder carousel over `[start, ...]` spinning through `images`, one caption
/// per image while it faces the camera. Returns the segment end time.
fn v_cylinder_segment(
    ctx: &VCtx,
    images: &[String],
    start: u32,
    dur: u32,
    xfade: u32,
    next_id: &mut u32,
    layers: &mut Vec<Layer>,
    caps: &mut Vec<(u32, ShapedText)>,
) -> u32 {
    let n = images.len() as u32;
    if n == 0 {
        return start;
    }
    let (radius, height) = carousel_dims(ctx.cw, ctx.ch, n);
    let cycle = (dur / n).max(500);
    let rotate = (cycle * 35 / 100).max(200);
    let pause = cycle.saturating_sub(rotate).max(150);
    let cycle = pause + rotate;
    let seg_end = start + cycle * n;
    let step = 360.0 / n as f32;
    let front0 = 180.0 - step * 0.5;
    let mut keys = Vec::new();
    for i in 0..=n {
        let angle = front0 - step * i as f32;
        let t = start + cycle * i;
        keys.push(Keyframe { time_ms: t, value: angle, easing: Easing::Linear });
        if i < n {
            keys.push(Keyframe { time_ms: t + pause, value: angle, easing: Easing::EaseInOut });
        }
    }
    let cyl_id = *next_id;
    *next_id += 1;
    layers.push(Layer {
        id: cyl_id,
        name: "Carousel".into(),
        start_ms: start,
        end_ms: seg_end,
        kind: LayerKind::Shape3D {
            shape: SurfaceShape::Cylinder,
            width: Track::constant(radius * 2.0),
            height: Track::constant(height),
            depth: Track::constant(radius * 2.0),
            rotation_x: Track::constant(0.0),
            rotation_y: Track { keys, default: front0 },
            rotation_z: Track::constant(0.0),
            perspective: Track::constant(0.35),
            focal_length: Track::constant(1200.0),
            coverage: Track::constant(360.0),
            radius: Track::constant(radius),
        },
        transform: Transform::at(ctx.cx, ctx.cy),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });
    for (i, path) in images.iter().enumerate() {
        let (iw, ih) = image::image_dimensions(path).unwrap_or((1, 1));
        let u = (i as f32 + 0.5) / n as f32;
        let (crop, _) = cover_crop(iw.max(1) as f32, ih.max(1) as f32, ctx.cw, ctx.ch);
        let id = *next_id;
        *next_id += 1;
        layers.push(Layer {
            id,
            name: format!("Carousel image {}", i + 1),
            start_ms: start,
            end_ms: seg_end,
            kind: LayerKind::Image { src: path.clone(), width: iw.max(1), height: ih.max(1), crop: Some(crop) },
            transform: Transform::at(ctx.cx, ctx.cy),
            hidden: false,
            attach: Some(Decal {
                shape_id: cyl_id,
                face: 0,
                u: Track::constant(u),
                v: Track::constant(0.5),
                scale: Track::constant(1.0),
                rotation: Track::constant(0.0),
            }),
            effects: vec![],
            transition_in: Some(v_fade(xfade)),
            transition_out: Some(v_fade(xfade)),
        });
        let c0 = start + cycle * i as u32 + 250;
        let c1 = (start + cycle * i as u32 + pause).saturating_sub(100).max(c0 + 500);
        v_caption(ctx, next_id, layers, caps, c0, c1);
    }
    seg_end
}

/// Rotating cube over `[start, ...]`; images on the four side faces cycle for
/// more than four. A caption per image while it faces the camera. Returns end.
fn v_box_segment(
    ctx: &VCtx,
    images: &[String],
    start: u32,
    dur: u32,
    xfade: u32,
    next_id: &mut u32,
    layers: &mut Vec<Layer>,
    caps: &mut Vec<(u32, ShapedText)>,
) -> u32 {
    let n = images.len() as u32;
    if n == 0 {
        return start;
    }
    let side = ctx.comp_min * 0.5;
    let cycle = (dur / n).max(500);
    let rotate = (cycle * 45 / 100).max(200);
    let pause = cycle.saturating_sub(rotate).max(150);
    let cycle = pause + rotate;
    let seg_end = start + (n - 1) * cycle + pause;
    let mut keys = Vec::new();
    for i in 0..n {
        let angle = -90.0 * i as f32;
        let t = start + i * cycle;
        keys.push(Keyframe { time_ms: t, value: angle, easing: Easing::Linear });
        if i + 1 < n {
            keys.push(Keyframe { time_ms: t + pause, value: angle, easing: Easing::EaseInOut });
        }
    }
    let box_id = *next_id;
    *next_id += 1;
    layers.push(Layer {
        id: box_id,
        name: "Cube".into(),
        start_ms: start,
        end_ms: seg_end,
        kind: LayerKind::Shape3D {
            shape: SurfaceShape::Box,
            width: Track::constant(side),
            height: Track::constant(side),
            depth: Track::constant(side),
            rotation_x: Track::constant(0.0),
            rotation_y: Track { keys, default: 0.0 },
            rotation_z: Track::constant(0.0),
            perspective: Track::constant(0.35),
            focal_length: Track::constant(1200.0),
            coverage: Track::constant(360.0),
            radius: Track::constant(side),
        },
        transform: Transform::at(ctx.cx, ctx.cy),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });
    const FACE_ORDER: [u32; 4] = [0, 3, 1, 2];
    for (i, path) in images.iter().enumerate() {
        let iu = i as u32;
        let (iw, ih) = image::image_dimensions(path).unwrap_or((1, 1));
        let face = FACE_ORDER[i % 4];
        let s0 = start + (iu.saturating_sub(2)) * cycle;
        let s1 = (start + (iu + 2) * cycle).min(seg_end);
        let tin = if i == 0 { Some(v_fade(xfade)) } else { None };
        let tout = if iu + 1 == n { Some(v_fade(xfade)) } else { None };
        let id = *next_id;
        *next_id += 1;
        layers.push(Layer {
            id,
            name: format!("Cube image {}", i + 1),
            start_ms: s0,
            end_ms: s1,
            kind: LayerKind::Image { src: path.clone(), width: iw.max(1), height: ih.max(1), crop: None },
            transform: Transform::at(ctx.cx, ctx.cy),
            hidden: false,
            attach: Some(Decal {
                shape_id: box_id,
                face,
                u: Track::constant(0.5),
                v: Track::constant(0.5),
                scale: Track::constant(0.9),
                rotation: Track::constant(0.0),
            }),
            effects: vec![],
            transition_in: tin,
            transition_out: tout,
        });
        let c0 = start + iu * cycle + 250;
        let c1 = (start + iu * cycle + pause).saturating_sub(100).max(c0 + 500);
        v_caption(ctx, next_id, layers, caps, c0, c1);
    }
    seg_end
}

/// Assembling photo grid over `[start, start+dur]`: a group of cover-cropped
/// images that fade in staggered, then hold. One caption for the segment.
fn v_grid_segment(
    ctx: &VCtx,
    images: &[String],
    start: u32,
    dur: u32,
    xfade: u32,
    next_id: &mut u32,
    layers: &mut Vec<Layer>,
    caps: &mut Vec<(u32, ShapedText)>,
) -> u32 {
    let n = images.len() as u32;
    if n == 0 {
        return start;
    }
    let cols = (n as f32).sqrt().ceil().max(1.0) as u32;
    let rows = (n + cols - 1) / cols;
    let margin = 0.06f32;
    let gap = 0.04f32;
    let cell_w = ctx.cw * (1.0 - 2.0 * margin) / cols as f32;
    let cell_h = ctx.ch * (1.0 - 2.0 * margin) / rows as f32;
    let inner_w = cell_w * (1.0 - gap);
    let inner_h = cell_h * (1.0 - gap);
    let origin_x = ctx.cw * margin;
    let origin_y = ctx.ch * margin;
    let empties = rows * cols - n;
    let seg_end = start + dur;
    let stagger = ((dur * 40 / 100) / n).max(80);

    let group_id = *next_id;
    *next_id += 1;
    let mut children: Vec<Layer> = Vec::with_capacity(n as usize);
    let mut child_next = group_id + 1;
    for (i, path) in images.iter().enumerate() {
        let iu = i as u32;
        let (iw, ih) = image::image_dimensions(path).unwrap_or((1, 1));
        let (iwf, ihf) = (iw.max(1) as f32, ih.max(1) as f32);
        let col = iu % cols;
        let row = iu / cols;
        let ccy = origin_y + (row as f32 + 0.5) * cell_h;
        let is_last_filler = iu + 1 == n && empties > 0;
        let (px, sx, crop) = if is_last_filler {
            let bl = origin_x + col as f32 * cell_w + cell_w * gap / 2.0;
            let br = origin_x + cols as f32 * cell_w - cell_w * gap / 2.0;
            let (crop, scale) = cover_crop(iwf, ihf, br - bl, inner_h);
            ((bl + br) / 2.0, scale, Some(crop))
        } else {
            let ccx = origin_x + (col as f32 + 0.5) * cell_w;
            let fit = (inner_w / iwf).min(inner_h / ihf);
            (ccx, fit, None)
        };
        let mut tf = Transform::at(px, ccy);
        tf.scale_x = Track::constant(sx);
        tf.scale_y = Track::constant(sx);
        let cid = child_next;
        child_next += 1;
        children.push(Layer {
            id: cid,
            name: format!("Grid image {}", i + 1),
            start_ms: start + iu * stagger,
            end_ms: seg_end,
            kind: LayerKind::Image { src: path.clone(), width: iw.max(1), height: ih.max(1), crop },
            transform: tf,
            hidden: false,
            attach: None,
            effects: vec![],
            transition_in: Some(v_fade(500)),
            transition_out: None,
        });
    }
    *next_id = child_next;
    layers.push(Layer {
        id: group_id,
        name: format!("Grid {cols}×{rows}"),
        start_ms: start,
        end_ms: seg_end,
        kind: LayerKind::Group { children },
        transform: Transform::at(0.0, 0.0),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: Some(v_fade(xfade)),
        transition_out: Some(v_fade(xfade)),
    });
    v_caption(ctx, next_id, layers, caps, start + xfade + 200, seg_end.saturating_sub(200));
    seg_end
}

/// Build one feature segment of the given kind; returns its end time.
fn v_feature_segment(
    kind: &str,
    ctx: &VCtx,
    images: &[String],
    start: u32,
    dur: u32,
    xfade: u32,
    next_id: &mut u32,
    layers: &mut Vec<Layer>,
    caps: &mut Vec<(u32, ShapedText)>,
) -> u32 {
    match kind {
        "box" => v_box_segment(ctx, images, start, dur, xfade, next_id, layers, caps),
        "grid" => v_grid_segment(ctx, images, start, dur, xfade, next_id, layers, caps),
        _ => v_cylinder_segment(ctx, images, start, dur, xfade, next_id, layers, caps),
    }
}

/// Template: a coherent ~`total_ms` video that opens with plain Ken-Burns slides,
/// transitions INTO one or two feature segments (cylinder / cube / grid), and
/// then back OUT to plain slides — every part cross-fading into the next, with a
/// bottom-right "text here" caption throughout. `plain` are the plain slides
/// (split into an intro and outro); `feature_a` / `feature_b` are the images that
/// go into the feature segments (`kind_b` empty = a single feature). Undoable.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn create_mixed_video(
    state: State<AppState>,
    plain: Vec<String>,
    feature_a: Vec<String>,
    feature_b: Vec<String>,
    kind_a: String,
    kind_b: String,
    total_ms: u32,
) -> Result<Project, String> {
    if feature_a.is_empty() {
        return Err("assign at least one image to the feature part".into());
    }
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);

    let ctx = VCtx {
        cw: project.width as f32,
        ch: project.height as f32,
        cx: project.width as f32 / 2.0,
        cy: project.height as f32 / 2.0,
        comp_min: project.width.min(project.height) as f32,
    };
    let xfade = 800u32;

    // Allocate time proportionally to each segment's image count.
    let has_b = !kind_b.is_empty() && !feature_b.is_empty();
    let intro_n = (plain.len() / 2) as u32;
    let intro: Vec<String> = plain.iter().take(intro_n as usize).cloned().collect();
    let outro: Vec<String> = plain.iter().skip(intro_n as usize).cloned().collect();
    let total_imgs = (plain.len() + feature_a.len() + feature_b.len()).max(1) as u32;
    let unit = (total_ms / total_imgs).max(1500);

    let base_id = max_layer_id(&project.layers);
    let mut next_id = base_id + 1;
    let mut layers: Vec<Layer> = Vec::new();
    let mut caps: Vec<(u32, ShapedText)> = Vec::new();

    let mut t = 0u32;
    if !intro.is_empty() {
        let end = v_plain_segment(&ctx, &intro, t, intro.len() as u32 * unit, xfade, &mut next_id, &mut layers, &mut caps);
        t = end.saturating_sub(xfade);
    }
    let end_a = v_feature_segment(&kind_a, &ctx, &feature_a, t, feature_a.len() as u32 * unit, xfade, &mut next_id, &mut layers, &mut caps);
    t = end_a.saturating_sub(xfade);
    if has_b {
        let end_b = v_feature_segment(&kind_b, &ctx, &feature_b, t, feature_b.len() as u32 * unit, xfade, &mut next_id, &mut layers, &mut caps);
        t = end_b.saturating_sub(xfade);
    }
    let end = if !outro.is_empty() {
        v_plain_segment(&ctx, &outro, t, outro.len() as u32 * unit, xfade, &mut next_id, &mut layers, &mut caps)
    } else {
        t + xfade
    };

    project.layers.extend(layers);
    {
        let mut shaped = state.shaped.lock().unwrap();
        for (id, st) in caps {
            shaped.insert(id, st);
        }
    }
    if project.duration_ms < end {
        project.duration_ms = end;
    }
    Ok(project.clone())
}

/// Replace a `Shape2D` layer's paint style wholesale (the frontend owns the
/// keyframe editing — it builds the colour-key lists and tracks and sends the
/// finished style, mirroring how text animators are set). Undoable.
#[tauri::command]
fn set_shape2d(state: State<AppState>, layer_id: u32, style: Shape2DStyle) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Shape2D { style: s, .. } => *s = style,
        _ => return Err("not a shape2d layer".into()),
    }
    Ok(project.clone())
}

/// Return only the paths that still exist as files on disk. Used to prune the
/// persisted media bin on startup so moved/deleted files drop out of it.
#[tauri::command]
fn filter_existing_files(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| std::path::Path::new(p).is_file()).collect()
}

/// Add a multi-frame grid (`rows`×`cols`) centred in the comp, sized to ~70% of
/// it. Cells start empty; the vertex lattice starts regular (no warp). Undoable.
#[tauri::command]
fn add_frame_grid(state: State<AppState>, rows: u32, cols: u32) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let rows = rows.clamp(1, 32);
    let cols = cols.clamp(1, 32);
    let next_id = max_layer_id(&project.layers) + 1;
    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    let end_ms = default_new_layer_end(project.duration_ms);
    // Fill ~70% of the comp, keeping cells as square as the aspect allows.
    let grid_w = project.width as f32 * 0.7;
    let grid_h = project.height as f32 * 0.7;
    let cell_w = grid_w / cols as f32;
    let cell_h = grid_h / rows as f32;
    let vertices = vec![GridVertex::default(); ((rows + 1) * (cols + 1)) as usize];
    let cells = vec![FrameCell::default(); (rows * cols) as usize];
    project.layers.push(Layer {
        id: next_id,
        name: format!("Grid {cols}×{rows}"),
        start_ms: 0,
        end_ms,
        kind: LayerKind::FrameGrid {
            rows,
            cols,
            cell_w,
            cell_h,
            vertices,
            constrain: ConstrainMode::FreeForm,
            cells,
            linked: vec![],
            line_width: 2.0,
            line_color: Rgba { r: 255, g: 255, b: 255, a: 255 },
            line_color_keys: vec![],
            background: None,
        },
        transform: Transform::at(cx, cy),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });
    project.clone()
}

/// Set (or replace) the image in one grid cell (`cell` = row-major index). Reads
/// the image's natural size for aspect-correct fitting. Undoable.
#[tauri::command]
fn set_cell_image(state: State<AppState>, layer_id: u32, cell: u32, path: String) -> Result<Project, String> {
    let (iw, ih) = image::image_dimensions(&path).unwrap_or((1, 1));
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    let c = cells.get_mut(cell as usize).ok_or("cell out of range")?;
    c.src = Some(path);
    c.img_w = iw;
    c.img_h = ih;
    Ok(project.clone())
}

/// Set the shared background image of a frame grid (each cell then shows its
/// aligned slice of it). Undoable.
#[tauri::command]
fn set_grid_background(state: State<AppState>, layer_id: u32, path: String) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { background, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    *background = Some(path);
    Ok(project.clone())
}

/// Clear a frame grid's shared background image (cells revert to their own). Undoable.
#[tauri::command]
fn clear_grid_background(state: State<AppState>, layer_id: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { background, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    *background = None;
    Ok(project.clone())
}

/// Clear the image from one grid cell. Undoable.
#[tauri::command]
fn clear_cell_image(state: State<AppState>, layer_id: u32, cell: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    let c = cells.get_mut(cell as usize).ok_or("cell out of range")?;
    c.src = None;
    Ok(project.clone())
}

/// One vertex move: the new ABSOLUTE local position for lattice vertex `index`
/// (row-major, (cols+1) wide). The backend converts it to the stored warp offset.
#[derive(serde::Deserialize)]
struct VertexMove {
    index: u32,
    x: f32,
    y: f32,
}

/// Move one or more `FrameGrid` lattice vertices to new local positions, keyframed
/// at `t_ms`. The frontend computes the affected set (single / multi-select /
/// rails), so this just converts each to a warp offset and upserts its keys.
/// Undoable.
#[tauri::command]
fn set_grid_vertices(
    state: State<AppState>,
    layer_id: u32,
    updates: Vec<VertexMove>,
    t_ms: u32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let start = project.layers.iter().find(|l| l.id == layer_id).map(|l| l.start_ms).unwrap_or(0);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { rows, cols, cell_w, cell_h, vertices, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    let vcols = *cols + 1;
    let grid_w = *cols as f32 * *cell_w;
    let grid_h = *rows as f32 * *cell_h;
    for up in updates {
        let Some(gv) = vertices.get_mut(up.index as usize) else { continue };
        let r = up.index / vcols;
        let c = up.index % vcols;
        let base_x = c as f32 * *cell_w - grid_w / 2.0;
        let base_y = r as f32 * *cell_h - grid_h / 2.0;
        upsert_key(&mut gv.dx, t_ms, Some(up.x - base_x), seed_start, start);
        upsert_key(&mut gv.dy, t_ms, Some(up.y - base_y), seed_start, start);
    }
    Ok(project.clone())
}

/// Set a `FrameGrid`'s vertex-drag constraint mode ("freeform" or "rails"). Not
/// keyframed. Undoable.
#[tauri::command]
fn set_grid_constrain(state: State<AppState>, layer_id: u32, mode: ConstrainMode) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { constrain, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    *constrain = mode;
    Ok(project.clone())
}

/// Set a `FrameGrid`'s grid-line thickness (layer-local px; 0 = hidden). Not
/// keyframed. Undoable.
#[tauri::command]
fn set_grid_line_width(state: State<AppState>, layer_id: u32, width: f32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { line_width, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    *line_width = width.clamp(0.0, 200.0);
    Ok(project.clone())
}

/// Keyframe a `FrameGrid`'s line colour at `t_ms` (so the gridline colour can
/// animate over the clip). Mirrors `set_text_color`. Undoable.
#[tauri::command]
fn set_grid_line_color(
    state: State<AppState>,
    layer_id: u32,
    color: Rgba,
    t_ms: u32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let start = project.layers.iter().find(|l| l.id == layer_id).map(|l| l.start_ms).unwrap_or(0);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { line_color, line_color_keys, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    let prev = eval::sample_color(line_color_keys, *line_color, t_ms);
    upsert_color_key(line_color_keys, t_ms, color, prev, seed_start, start);
    // Keep the static base in sync so a single (unkeyed) colour reads immediately.
    if line_color_keys.len() <= 1 {
        *line_color = color;
    }
    Ok(project.clone())
}

/// Clear a `FrameGrid`'s line-colour keyframes, freezing it at `color`. Undoable.
#[tauri::command]
fn clear_grid_line_color(state: State<AppState>, layer_id: u32, color: Rgba) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { line_color, line_color_keys, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    line_color_keys.clear();
    *line_color = color;
    Ok(project.clone())
}

/// Keyframe a grid cell's image zoom at `t_ms` (1 = fit, >1 = zoomed in). Drops a
/// keyframe at the playhead so the zoom can animate. Undoable.
#[tauri::command]
fn set_cell_zoom(
    state: State<AppState>,
    layer_id: u32,
    cell: u32,
    zoom: f32,
    t_ms: u32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let start = project.layers.iter().find(|l| l.id == layer_id).map(|l| l.start_ms).unwrap_or(0);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    let c = cells.get_mut(cell as usize).ok_or("cell out of range")?;
    upsert_key(&mut c.zoom, t_ms, Some(zoom.max(0.01)), seed_start, start);
    Ok(project.clone())
}

/// Keyframe a grid cell's image pan at `t_ms` (position within its cell, in
/// fractions of the cell; 0 = centred). Drops keys on both axes at the playhead
/// so the pan can animate. Undoable.
#[tauri::command]
fn set_cell_pan(
    state: State<AppState>,
    layer_id: u32,
    cell: u32,
    x: f32,
    y: f32,
    t_ms: u32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let start = project.layers.iter().find(|l| l.id == layer_id).map(|l| l.start_ms).unwrap_or(0);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    let c = cells.get_mut(cell as usize).ok_or("cell out of range")?;
    upsert_key(&mut c.pan_x, t_ms, Some(x), seed_start, start);
    upsert_key(&mut c.pan_y, t_ms, Some(y), seed_start, start);
    Ok(project.clone())
}

/// Merge the cell at `cell` (row-major) with its neighbour to the `"right"` or
/// `"down"`, growing it into a merged block. The master keeps its image; the
/// absorbed cells' images are cleared. No-op (returns unchanged) if the merge
/// isn't a clean rectangle (target slots must be single, unmerged, and free).
/// Undoable.
#[tauri::command]
fn merge_cell(state: State<AppState>, layer_id: u32, cell: u32, dir: String) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    let layer = project.layers.iter().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { rows, cols, cells, .. } = &layer.kind else {
        return Err("not a frame grid".into());
    };
    let (rows, cols) = (*rows, *cols);
    let (covered, spans) = model::grid_layout(rows, cols, cells);
    let idx = cell as usize;
    if idx >= (rows * cols) as usize || covered[idx] {
        return Ok(project.clone()); // not a master → nothing to merge
    }
    let r = cell / cols;
    let c = cell % cols;
    let (rs, cs) = spans[idx];
    // The line of slots we'd absorb; each must exist, be uncovered, and be single.
    let targets: Vec<u32> = match dir.as_str() {
        "right" => {
            if c + cs >= cols {
                return Ok(project.clone());
            }
            (r..r + rs).map(|rr| rr * cols + (c + cs)).collect()
        }
        "down" => {
            if r + rs >= rows {
                return Ok(project.clone());
            }
            (c..c + cs).map(|cc| (r + rs) * cols + cc).collect()
        }
        _ => return Err("dir must be \"right\" or \"down\"".into()),
    };
    for &t in &targets {
        let ti = t as usize;
        if covered[ti] || spans[ti] != (1, 1) {
            return Ok(project.clone()); // would make a non-rectangular merge
        }
    }
    // Commit: grow the master's span, clear absorbed images.
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).unwrap();
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else { unreachable!() };
    match dir.as_str() {
        "right" => cells[idx].col_span = cs + 1,
        _ => cells[idx].row_span = rs + 1,
    }
    for &t in &targets {
        cells[t as usize].src = None;
    }
    Ok(project.clone())
}

/// Set (or clear) a grid cell's in/out transition. `engine` = the transition id
/// (None/empty clears the slot). Played over the grid layer's start/end. Undoable.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_cell_transition(
    state: State<AppState>,
    layer_id: u32,
    cell: u32,
    slot: String,
    dur_ms: u32,
    direction: u8,
    engine: Option<String>,
    params: Option<String>,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    let c = cells.get_mut(cell as usize).ok_or("cell out of range")?;
    let transition = engine
        .filter(|s| !s.is_empty())
        .map(|id| Transition { kind: TransitionKind::Dissolve, dur_ms, direction, engine: Some(id), params });
    match slot.as_str() {
        "in" => c.transition_in = transition,
        "out" => c.transition_out = transition,
        _ => return Err("slot must be \"in\" or \"out\"".into()),
    }
    Ok(project.clone())
}

/// Set (or clear) the SAME in/out transition on every cell of a grid at once —
/// the "apply a transition to all the grid's images" action. `engine` empty/None
/// clears the slot on all cells. One undo step. Undoable.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_all_cells_transition(
    state: State<AppState>,
    layer_id: u32,
    slot: String,
    dur_ms: u32,
    direction: u8,
    engine: Option<String>,
    params: Option<String>,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    let id = engine.filter(|s| !s.is_empty());
    for c in cells.iter_mut() {
        let transition = id.clone().map(|id| Transition {
            kind: TransitionKind::Dissolve,
            dur_ms,
            direction,
            engine: Some(id),
            params: params.clone(),
        });
        match slot.as_str() {
            "in" => c.transition_in = transition,
            "out" => c.transition_out = transition,
            _ => return Err("slot must be \"in\" or \"out\"".into()),
        }
    }
    Ok(project.clone())
}

/// Split a merged cell back into single slots (its `col_span`/`row_span` reset to
/// 1). The previously-absorbed slots reappear empty. Undoable.
#[tauri::command]
fn split_cell(state: State<AppState>, layer_id: u32, cell: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    let c = cells.get_mut(cell as usize).ok_or("cell out of range")?;
    c.col_span = 1;
    c.row_span = 1;
    Ok(project.clone())
}

/// Set a `Shape3D` layer's dimension + camera parameters. Each is a keyframeable
/// `Track` (the frontend upserts a key at the playhead when the stopwatch is on,
/// mirroring `set_shape2d`). Rotations are keyed separately
/// (`set_shape_rotation_key`). Clamping happens at sample time in the evaluator.
/// Undoable.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_shape_params(
    state: State<AppState>,
    layer_id: u32,
    width: Track,
    height: Track,
    depth: Track,
    perspective: Track,
    focal_length: Track,
    coverage: Track,
    radius: Track,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Shape3D {
            width: w,
            height: h,
            depth: d,
            perspective: p,
            focal_length: f,
            coverage: c,
            radius: r,
            ..
        } => {
            *w = width;
            *h = height;
            *d = depth;
            *p = perspective;
            *f = focal_length;
            *c = coverage;
            *r = radius;
        }
        _ => return Err("not a shape layer".into()),
    }
    Ok(project.clone())
}

/// Key one 3D-rotation axis (`"x"`/`"y"`/`"z"`) of a `Shape3D` at `t_ms` — this
/// animates the spin. `seed_start=true` drops a keyframe holding the default at
/// the layer start, so a single key animates from the beginning.
#[tauri::command]
fn set_shape_rotation_key(
    state: State<AppState>,
    layer_id: u32,
    axis: String,
    t_ms: u32,
    value: f32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let start = layer.start_ms;
    match &mut layer.kind {
        LayerKind::Shape3D { rotation_x, rotation_y, rotation_z, .. } => {
            let track = match axis.as_str() {
                "x" => rotation_x,
                "y" => rotation_y,
                "z" => rotation_z,
                _ => return Err("axis must be x, y or z".into()),
            };
            upsert_key(track, t_ms, Some(value), seed_start, start);
        }
        _ => return Err("not a shape layer".into()),
    }
    Ok(project.clone())
}

/// Pin a layer (image or text) to a `Shape3D` so it renders as a decal, or with
/// `shape_id = None` detach it back to flat. Defaults the placement to the centre
/// of the chosen face (cylinders wrap full-height). Undoable.
#[tauri::command]
fn attach_to_shape(
    state: State<AppState>,
    layer_id: u32,
    shape_id: Option<u32>,
    face: u32,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let scale = match shape_id {
        Some(sid) if is_cylinder(&project, sid) => 1.0,
        _ => 0.5,
    };
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    if !matches!(layer.kind, LayerKind::Image { .. } | LayerKind::Text { .. }) {
        return Err("only image or text layers can be pinned".into());
    }
    layer.attach = shape_id.map(|sid| Decal::new(sid, face, scale));
    Ok(project.clone())
}

/// Whether a layer id refers to a cylinder shape.
fn is_cylinder(project: &Project, shape_id: u32) -> bool {
    project.layers.iter().any(|l| {
        l.id == shape_id
            && matches!(&l.kind, LayerKind::Shape3D { shape: SurfaceShape::Cylinder, .. })
    })
}

/// Try to drop a layer onto a shape's surface at comp point `(x, y)`. If the
/// point is over a (front-facing) shape surface, the layer is pinned there and
/// its `u`/`v` placement is keyed at `t_ms` (so dragging across the surface at
/// different times animates it). Returns the new project, or `None` if the point
/// wasn't over any shape (the caller treats the drag as an ordinary move). Used
/// for dropping a flat layer and for dragging a decal's handle. Undoable.
#[tauri::command]
fn drop_image_on_shape(
    state: State<AppState>,
    image_id: u32,
    x: f32,
    y: f32,
    t_ms: u32,
) -> Option<Project> {
    let mut project = state.project.lock().unwrap();
    // Top-most shape first (later layers draw on top).
    let mut hit: Option<(u32, u32, f32, f32)> = None;
    for layer in project.layers.iter().rev() {
        if let Some(st) = eval::shape_state_for(layer, t_ms) {
            if let Some((face, u, v)) = surface::pick_surface(&st, x, y) {
                hit = Some((layer.id, face, u, v));
                break;
            }
        }
    }
    let (shape_id, face, u, v) = hit?;
    let pinnable = project.layers.iter().any(|l| {
        l.id == image_id && matches!(l.kind, LayerKind::Image { .. } | LayerKind::Text { .. })
    });
    if !pinnable {
        return None;
    }
    let default_scale = if is_cylinder(&project, shape_id) { 1.0 } else { 0.5 };
    let start = project.layers.iter().find(|l| l.id == image_id).map(|l| l.start_ms).unwrap_or(0);
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == image_id)?;
    // Create the decal on first pin, or re-point an existing one to the new
    // shape/face, then key u/v at the drop time.
    let decal = layer.attach.get_or_insert_with(|| Decal::new(shape_id, face, default_scale));
    decal.shape_id = shape_id;
    decal.face = face;
    upsert_key(&mut decal.u, t_ms, Some(u), true, start);
    upsert_key(&mut decal.v, t_ms, Some(v), true, start);
    Some(project.clone())
}

/// Key one of a decal's placement tracks (`"u"`, `"v"`, `"scale"`, `"rotation"`)
/// at `t_ms`. This is how moving/sizing a decal on the surface becomes animation.
/// `seed_start=true` drops a keyframe at the layer start holding the old value.
/// Undoable.
#[tauri::command]
fn key_decal(
    state: State<AppState>,
    layer_id: u32,
    prop: String,
    t_ms: u32,
    value: f32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let start = layer.start_ms;
    let decal = layer.attach.as_mut().ok_or("layer is not pinned to a shape")?;
    let track = match prop.as_str() {
        "u" => &mut decal.u,
        "v" => &mut decal.v,
        "scale" => &mut decal.scale,
        "rotation" => &mut decal.rotation,
        _ => return Err("prop must be u, v, scale or rotation".into()),
    };
    upsert_key(track, t_ms, Some(value), seed_start, start);
    Ok(project.clone())
}

/// Set which box face a decal sits on (not keyframed). Undoable.
#[tauri::command]
fn set_decal_face(state: State<AppState>, layer_id: u32, face: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let decal = layer.attach.as_mut().ok_or("layer is not pinned to a shape")?;
    decal.face = face;
    Ok(project.clone())
}

/// The keyframeable Track of an effect for a parameter name, if it has one.
fn effect_track_mut<'a>(e: &'a mut Effect, param: &str) -> Option<&'a mut Track> {
    match (e, param) {
        (Effect::Grayscale { amount }, "amount") => Some(amount),
        (Effect::Brightness { amount }, "amount") => Some(amount),
        (Effect::Contrast { amount }, "amount") => Some(amount),
        (Effect::Saturate { amount }, "amount") => Some(amount),
        (Effect::Blur { radius }, "radius") => Some(radius),
        (Effect::Hue { degrees }, "degrees") => Some(degrees),
        (Effect::Invert { amount }, "amount") => Some(amount),
        (Effect::Wipe { position, .. }, "position") => Some(position),
        (Effect::Wipe { softness, .. }, "softness") => Some(softness),
        (Effect::ShinyClouds { intensity, .. }, "intensity") => Some(intensity),
        (Effect::ShinyClouds { scale, .. }, "scale") => Some(scale),
        (Effect::ShinyClouds { speed, .. }, "speed") => Some(speed),
        (Effect::ShinyClouds { complexity, .. }, "complexity") => Some(complexity),
        (Effect::ShinyClouds { contrast, .. }, "contrast") => Some(contrast),
        (Effect::ShinyClouds { brightness, .. }, "brightness") => Some(brightness),
        (Effect::ShinyClouds { opacity, .. }, "opacity") => Some(opacity),
        (Effect::GpuOverlay { intensity, .. }, "intensity") => Some(intensity),
        (Effect::GpuOverlay { scale, .. }, "scale") => Some(scale),
        (Effect::GpuOverlay { speed, .. }, "speed") => Some(speed),
        (Effect::GpuOverlay { detail, .. }, "detail") => Some(detail),
        (Effect::GpuOverlay { softness, .. }, "softness") => Some(softness),
        (Effect::GpuOverlay { extra, .. }, "extra") => Some(extra),
        (Effect::GpuOverlay { opacity, .. }, "opacity") => Some(opacity),
        _ => None,
    }
}

/// Append a default effect of the named kind to a layer's effect stack. Undoable.
#[tauri::command]
fn add_effect(state: State<AppState>, layer_id: u32, kind: String) -> Result<Project, String> {
    let effect = Effect::default_of(&kind).ok_or("unknown effect kind")?;
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    layer.effects.push(effect);
    Ok(project.clone())
}

/// Remove the effect at `index` from a layer's stack. Undoable.
#[tauri::command]
fn remove_effect(state: State<AppState>, layer_id: u32, index: usize) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    if index < layer.effects.len() {
        layer.effects.remove(index);
    }
    Ok(project.clone())
}

/// Key one parameter (`amount`/`radius`/`degrees`/`position`/`softness`) of the
/// effect at `index` at `t_ms`. This is how an effect animates. Undoable.
#[tauri::command]
fn key_effect(
    state: State<AppState>,
    layer_id: u32,
    index: usize,
    param: String,
    t_ms: u32,
    value: f32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let start = layer.start_ms;
    let effect = layer.effects.get_mut(index).ok_or("effect index out of range")?;
    let track = effect_track_mut(effect, &param).ok_or("effect has no such parameter")?;
    upsert_key(track, t_ms, Some(value), seed_start, start);
    Ok(project.clone())
}

/// Set a wipe effect's static fields: `angle` (degrees) and `invert`. Undoable.
#[tauri::command]
fn set_wipe_static(
    state: State<AppState>,
    layer_id: u32,
    index: usize,
    angle: f32,
    invert: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match layer.effects.get_mut(index) {
        Some(Effect::Wipe { angle: a, invert: inv, .. }) => {
            *a = angle;
            *inv = invert;
        }
        _ => return Err("not a wipe effect".into()),
    }
    Ok(project.clone())
}

/// Set a shiny-clouds effect's static fields: `tint` (shine colour) and `blend`
/// mode (0 Add · 1 Screen · 2 Overlay · 3 Soft Light). Undoable.
#[tauri::command]
fn set_shine_static(
    state: State<AppState>,
    layer_id: u32,
    index: usize,
    tint: Rgba,
    blend: u8,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match layer.effects.get_mut(index) {
        Some(Effect::ShinyClouds { tint: t, blend: b, .. }) => {
            *t = tint;
            *b = blend;
        }
        _ => return Err("not a shiny clouds effect".into()),
    }
    Ok(project.clone())
}

/// Set a GPU-overlay effect's static fields: which `effect`, `tint`/`tint2`,
/// flare `pos`, and `blend` mode. Undoable.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_gpufx_static(
    state: State<AppState>,
    layer_id: u32,
    index: usize,
    effect: u8,
    tint: Rgba,
    tint2: Rgba,
    pos_x: f32,
    pos_y: f32,
    blend: u8,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match layer.effects.get_mut(index) {
        Some(Effect::GpuOverlay { effect: e, tint: t, tint2: t2, pos_x: px, pos_y: py, blend: b, .. }) => {
            *e = effect;
            *t = tint;
            *t2 = tint2;
            *px = pos_x;
            *py = pos_y;
            *b = blend;
        }
        _ => return Err("not a gpu overlay effect".into()),
    }
    Ok(project.clone())
}

/// Borrow one grid cell's effect stack mutably (errors if not a grid / bad cell).
fn cell_effects_mut(layer: &mut Layer, cell: u32) -> Result<&mut Vec<Effect>, String> {
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    Ok(&mut cells.get_mut(cell as usize).ok_or("cell out of range")?.effects)
}

/// Append a default effect of `kind` to a grid cell's own effect stack. Undoable.
#[tauri::command]
fn add_cell_effect(state: State<AppState>, layer_id: u32, cell: u32, kind: String) -> Result<Project, String> {
    let effect = Effect::default_of(&kind).ok_or("unknown effect kind")?;
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    cell_effects_mut(layer, cell)?.push(effect);
    Ok(project.clone())
}

/// Remove the effect at `index` from a grid cell's stack. Undoable.
#[tauri::command]
fn remove_cell_effect(state: State<AppState>, layer_id: u32, cell: u32, index: usize) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let fx = cell_effects_mut(layer, cell)?;
    if index < fx.len() {
        fx.remove(index);
    }
    Ok(project.clone())
}

/// Key one parameter of a grid cell's effect at `index`, at `t_ms`. Undoable.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn key_cell_effect(
    state: State<AppState>,
    layer_id: u32,
    cell: u32,
    index: usize,
    param: String,
    t_ms: u32,
    value: f32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let start = layer.start_ms;
    let fx = cell_effects_mut(layer, cell)?;
    let effect = fx.get_mut(index).ok_or("effect index out of range")?;
    let track = effect_track_mut(effect, &param).ok_or("effect has no such parameter")?;
    upsert_key(track, t_ms, Some(value), seed_start, start);
    Ok(project.clone())
}

/// Set a grid cell's wipe-effect static fields (`angle`, `invert`). Undoable.
#[tauri::command]
fn set_cell_wipe_static(
    state: State<AppState>,
    layer_id: u32,
    cell: u32,
    index: usize,
    angle: f32,
    invert: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    match cell_effects_mut(layer, cell)?.get_mut(index) {
        Some(Effect::Wipe { angle: a, invert: inv, .. }) => {
            *a = angle;
            *inv = invert;
        }
        _ => return Err("not a wipe effect".into()),
    }
    Ok(project.clone())
}

/// Set a grid cell's shiny-clouds effect static fields (tint + blend). Undoable.
#[tauri::command]
fn set_cell_shine_static(
    state: State<AppState>,
    layer_id: u32,
    cell: u32,
    index: usize,
    tint: Rgba,
    blend: u8,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    match cell_effects_mut(layer, cell)?.get_mut(index) {
        Some(Effect::ShinyClouds { tint: t, blend: b, .. }) => {
            *t = tint;
            *b = blend;
        }
        _ => return Err("not a shiny clouds effect".into()),
    }
    Ok(project.clone())
}

/// Set a grid cell's GPU-overlay effect static fields. Undoable.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_cell_gpufx_static(
    state: State<AppState>,
    layer_id: u32,
    cell: u32,
    index: usize,
    effect: u8,
    tint: Rgba,
    tint2: Rgba,
    pos_x: f32,
    pos_y: f32,
    blend: u8,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    match cell_effects_mut(layer, cell)?.get_mut(index) {
        Some(Effect::GpuOverlay { effect: e, tint: t, tint2: t2, pos_x: px, pos_y: py, blend: b, .. }) => {
            *e = effect;
            *t = tint;
            *t2 = tint2;
            *px = pos_x;
            *py = pos_y;
            *b = blend;
        }
        _ => return Err("not a gpu overlay effect".into()),
    }
    Ok(project.clone())
}

/// Replace one grid cell's whole effect stack with `effects` (the copy/paste
/// clipboard). The pasted effects carry their own keyframes, so the target cell
/// gets an identical, independent copy. Undoable.
#[tauri::command]
fn paste_cell_effects(
    state: State<AppState>,
    layer_id: u32,
    cell: u32,
    effects: Vec<Effect>,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    *cell_effects_mut(layer, cell)? = effects;
    Ok(project.clone())
}

/// Paste the same effect stack onto EVERY cell of a grid at once (except the
/// `except` cell, if given — normally the source cell keeps its original). One
/// undo step. Undoable.
#[tauri::command]
fn paste_cell_effects_all(
    state: State<AppState>,
    layer_id: u32,
    effects: Vec<Effect>,
    except: Option<u32>,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    for (i, c) in cells.iter_mut().enumerate() {
        if except == Some(i as u32) {
            continue;
        }
        c.effects = effects.clone();
    }
    Ok(project.clone())
}

/// Call `f` on each keyframeable `Track` belonging to ONE grid cell (its zoom +
/// its effect stack). Used by the per-cell child-timeline keyframe editing so a
/// retime/delete only touches that cell.
fn for_each_cell_track_mut(
    layer: &mut Layer,
    cell: u32,
    mut f: impl FnMut(&mut Track),
) -> Result<(), String> {
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    let c = cells.get_mut(cell as usize).ok_or("cell out of range")?;
    f(&mut c.zoom);
    f(&mut c.pan_x);
    f(&mut c.pan_y);
    for e in c.effects.iter_mut() {
        walk_effect_tracks(e, &mut f);
    }
    Ok(())
}

/// Retime every keyframe of one grid cell that sits at `from_ms` to `to_ms`
/// (drag a diamond in the cell's child timeline). Undoable.
#[tauri::command]
fn move_cell_keyframes_at(
    state: State<AppState>,
    layer_id: u32,
    cell: u32,
    from_ms: u32,
    to_ms: u32,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    let dur = project.duration_ms;
    state.snapshot(&project);
    let to = to_ms.min(dur);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    if to == from_ms {
        return Ok(project.clone());
    }
    for_each_cell_track_mut(layer, cell, |tr| {
        if !tr.keys.iter().any(|k| k.time_ms == from_ms) {
            return;
        }
        tr.keys.retain(|k| k.time_ms != to);
        for k in tr.keys.iter_mut() {
            if k.time_ms == from_ms {
                k.time_ms = to;
            }
        }
        tr.keys.sort_by(|a, b| a.time_ms.cmp(&b.time_ms));
    })?;
    Ok(project.clone())
}

/// Delete every keyframe of one grid cell that sits at `t_ms`. Undoable.
#[tauri::command]
fn delete_cell_keyframes_at(
    state: State<AppState>,
    layer_id: u32,
    cell: u32,
    t_ms: u32,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    for_each_cell_track_mut(layer, cell, |tr| tr.keys.retain(|k| k.time_ms != t_ms))?;
    Ok(project.clone())
}

/// Borrow a grid's linked-effect groups mutably.
fn grid_linked_mut(layer: &mut Layer) -> Result<&mut Vec<LinkedEffectGroup>, String> {
    let LayerKind::FrameGrid { linked, .. } = &mut layer.kind else {
        return Err("not a frame grid".into());
    };
    Ok(linked)
}

/// Borrow one linked group's shared effect stack mutably.
fn linked_effects_mut(layer: &mut Layer, group_id: u32) -> Result<&mut Vec<Effect>, String> {
    let g = grid_linked_mut(layer)?
        .iter_mut()
        .find(|g| g.id == group_id)
        .ok_or("linked group not found")?;
    Ok(&mut g.effects)
}

/// Create a linked effect group: a shared stack (one default effect of `kind`)
/// applied across `cells`. Editing it later updates every member. Undoable.
#[tauri::command]
fn link_effect(state: State<AppState>, layer_id: u32, kind: String, cells: Vec<u32>) -> Result<Project, String> {
    let effect = Effect::default_of(&kind).ok_or("unknown effect kind")?;
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let linked = grid_linked_mut(layer)?;
    let id = linked.iter().map(|g| g.id).max().unwrap_or(0) + 1;
    linked.push(LinkedEffectGroup { id, effects: vec![effect], members: cells });
    Ok(project.clone())
}

/// Append a default effect of `kind` to a linked group's shared stack. Undoable.
#[tauri::command]
fn add_linked_effect(state: State<AppState>, layer_id: u32, group_id: u32, kind: String) -> Result<Project, String> {
    let effect = Effect::default_of(&kind).ok_or("unknown effect kind")?;
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    linked_effects_mut(layer, group_id)?.push(effect);
    Ok(project.clone())
}

/// Remove the effect at `index` from a linked group's stack. Undoable.
#[tauri::command]
fn remove_linked_effect_item(state: State<AppState>, layer_id: u32, group_id: u32, index: usize) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let fx = linked_effects_mut(layer, group_id)?;
    if index < fx.len() {
        fx.remove(index);
    }
    Ok(project.clone())
}

/// Key one parameter of a linked group's effect at `index`, at `t_ms`. Undoable.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn key_linked_effect(
    state: State<AppState>,
    layer_id: u32,
    group_id: u32,
    index: usize,
    param: String,
    t_ms: u32,
    value: f32,
    seed_start: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let start = layer.start_ms;
    let fx = linked_effects_mut(layer, group_id)?;
    let effect = fx.get_mut(index).ok_or("effect index out of range")?;
    let track = effect_track_mut(effect, &param).ok_or("effect has no such parameter")?;
    upsert_key(track, t_ms, Some(value), seed_start, start);
    Ok(project.clone())
}

/// Set a linked group's wipe-effect static fields. Undoable.
#[tauri::command]
fn set_linked_wipe_static(
    state: State<AppState>,
    layer_id: u32,
    group_id: u32,
    index: usize,
    angle: f32,
    invert: bool,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    match linked_effects_mut(layer, group_id)?.get_mut(index) {
        Some(Effect::Wipe { angle: a, invert: inv, .. }) => {
            *a = angle;
            *inv = invert;
        }
        _ => return Err("not a wipe effect".into()),
    }
    Ok(project.clone())
}

/// Delete a linked group entirely (its effects vanish from all members). Undoable.
#[tauri::command]
fn remove_linked_group(state: State<AppState>, layer_id: u32, group_id: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    grid_linked_mut(layer)?.retain(|g| g.id != group_id);
    Ok(project.clone())
}

/// Add or remove a cell from a linked group's membership. Undoable.
#[tauri::command]
fn set_linked_member(state: State<AppState>, layer_id: u32, group_id: u32, cell: u32, member: bool) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    let g = grid_linked_mut(layer)?.iter_mut().find(|g| g.id == group_id).ok_or("linked group not found")?;
    if member {
        if !g.members.contains(&cell) {
            g.members.push(cell);
        }
    } else {
        g.members.retain(|&c| c != cell);
    }
    Ok(project.clone())
}

/// Unlink a cell from a group: remove it from the members AND copy the group's
/// effects into the cell's own stack, so it keeps the look but can now diverge.
/// Undoable.
#[tauri::command]
fn unlink_cell(state: State<AppState>, layer_id: u32, group_id: u32, cell: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project.layers.iter_mut().find(|l| l.id == layer_id).ok_or("layer not found")?;
    // Snapshot the group's effects, then drop the cell from its members.
    let effects = {
        let g = grid_linked_mut(layer)?.iter_mut().find(|g| g.id == group_id).ok_or("linked group not found")?;
        if !g.members.contains(&cell) {
            return Ok(project.clone());
        }
        g.members.retain(|&c| c != cell);
        g.effects.clone()
    };
    let LayerKind::FrameGrid { cells, .. } = &mut layer.kind else { unreachable!() };
    if let Some(c) = cells.get_mut(cell as usize) {
        c.effects.extend(effects);
    }
    Ok(project.clone())
}

/// Write raw bytes (base64-encoded over IPC) to an absolute path — used to save
/// the exported video file.
#[tauri::command]
fn save_binary_file(path: String, base64: String) -> Result<(), String> {
    let bytes = STANDARD.decode(base64.as_bytes()).map_err(|e| format!("decode: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write {path}: {e}"))
}

/// Recursively look for an executable named `name` under `dir`, up to `depth`.
fn find_exe(dir: &std::path::Path, name: &str, depth: u32) -> Option<std::path::PathBuf> {
    if depth == 0 {
        return None;
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find_exe(&p, name, depth - 1) {
                return Some(found);
            }
        } else if p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case(name))
            .unwrap_or(false)
        {
            return Some(p);
        }
    }
    None
}

/// Build a `Command` that never flashes a console window. The app is a GUI
/// (windows_subsystem = "windows"), so spawning a console-subsystem child like
/// ffmpeg or winget would otherwise pop a black cmd window — and closing that
/// window kills the child, crashing an in-progress render. CREATE_NO_WINDOW
/// keeps the whole thing invisible. No-op on non-Windows.
fn quiet_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Locate an `ffmpeg` executable. Checks PATH first, then the locations winget
/// installs to (its running-process PATH isn't refreshed after an install), then
/// a couple of common spots.
fn find_ffmpeg() -> Option<std::path::PathBuf> {
    // On PATH?
    if quiet_command("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        return Some("ffmpeg".into());
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let base = std::path::Path::new(&local).join("Microsoft").join("WinGet");
        let link = base.join("Links").join("ffmpeg.exe");
        if link.exists() {
            return Some(link);
        }
        if let Some(p) = find_exe(&base.join("Packages"), "ffmpeg.exe", 5) {
            return Some(p);
        }
    }
    for cand in [
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    ] {
        let p = std::path::PathBuf::from(cand);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Report the located ffmpeg path (or `None`) so the UI can offer MP4 export.
#[tauri::command]
fn ffmpeg_status() -> Option<String> {
    find_ffmpeg().map(|p| p.to_string_lossy().into_owned())
}

/// Install ffmpeg via winget (blocking — may take a while). Returns once it's
/// found, or the winget error.
#[tauri::command]
fn install_ffmpeg() -> Result<String, String> {
    let out = quiet_command("winget")
        .args([
            "install",
            "--id",
            "Gyan.FFmpeg",
            "-e",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--disable-interactivity",
        ])
        .output()
        .map_err(|e| format!("winget not available: {e}"))?;
    if find_ffmpeg().is_some() {
        Ok("ffmpeg installed".into())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(if err.trim().is_empty() {
            "winget finished but ffmpeg wasn't found".into()
        } else {
            err.into_owned()
        })
    }
}

/// One audio clip to mux into the exported video: its file `path`, when it
/// starts in the comp (`start_ms`), and how long it plays (`play_ms`, already
/// clamped to the clip's own length and its timeline trim).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AudioTrack {
    pub path: String,
    #[serde(rename = "startMs")]
    pub start_ms: u32,
    #[serde(rename = "playMs")]
    pub play_ms: u32,
    /// Where in the source file this clip starts (ms). Non-zero when a partial
    /// export begins partway through the clip. Defaults to 0 for a full export.
    #[serde(rename = "sourceInMs", default)]
    pub source_in_ms: u32,
}

/// Build the ffmpeg `-filter_complex` graph that trims each audio clip to its
/// play length, delays it to its comp start, and mixes them into one `[aout]`
/// stream capped at the comp duration. Audio inputs are ffmpeg inputs 1..=N (0 is
/// the video). Returns None if there are no usable tracks.
fn audio_filter_complex(audio: &[AudioTrack], duration_ms: u32) -> Option<String> {
    if audio.is_empty() {
        return None;
    }
    let dur = duration_ms as f64 / 1000.0;
    let mut fc = String::new();
    for (i, a) in audio.iter().enumerate() {
        let inp = i + 1; // input 0 is the video
        let src_in = a.source_in_ms as f64 / 1000.0;
        let play = a.play_ms as f64 / 1000.0;
        // Trim [source_in, source_in + play] out of the file, restamp to zero, then
        // delay to the clip's start in the exported timeline.
        fc.push_str(&format!(
            "[{inp}:a]atrim={src_in:.3}:{end:.3},asetpts=PTS-STARTPTS,adelay={delay}:all=1[a{i}];",
            end = src_in + play,
            delay = a.start_ms
        ));
    }
    let n = audio.len();
    if n == 1 {
        fc.push_str(&format!("[a0]atrim=0:{dur:.3}[aout]"));
    } else {
        for i in 0..n {
            fc.push_str(&format!("[a{i}]"));
        }
        fc.push_str(&format!("amix=inputs={n}:normalize=0,atrim=0:{dur:.3}[aout]"));
    }
    Some(fc)
}

/// Target video bitrate (bits/s) for a 1..5 compression level (1 = near-original
/// / largest, 5 = highest compression / smallest). Mirrors the frontend's
/// `bitrateForLevel` so the dialog's size estimate matches the encoder.
fn bitrate_for_level(level: u8) -> u32 {
    let mbps = match level {
        1 => 24,
        2 => 14,
        3 => 8,
        4 => 5,
        _ => 3,
    };
    mbps * 1_000_000
}

/// Save the exported video. `webm_base64` is the recorded (video-only) WebM.
/// `format` "webm" writes it as-is when there's no audio, else remuxes with an
/// Opus track; "mp4" transcodes to H.264 (+ AAC audio). `rate_mode` picks the
/// H.264 rate control (always constrained ABR so size is predictable): "bitrate"
/// targets `bitrate` bits/s; "quality" targets the 1..5 `level`'s preset bitrate.
/// Either way output size ≈ target × duration, matching the dialog's estimate.
/// `audio` are the comp's audio clips to mix in; muxing needs ffmpeg.
#[tauri::command]
fn export_video(
    webm_base64: String,
    path: String,
    format: String,
    rate_mode: String,
    level: u8,
    bitrate: u32,
    audio: Vec<AudioTrack>,
    duration_ms: u32,
) -> Result<(), String> {
    let bytes = STANDARD
        .decode(webm_base64.as_bytes())
        .map_err(|e| format!("decode: {e}"))?;

    let ffmpeg = find_ffmpeg();
    let filter = audio_filter_complex(&audio, duration_ms);
    let has_audio = filter.is_some() && ffmpeg.is_some();

    // Fast path: WebM with no audio to mux → write the recorded bytes as-is.
    if format == "webm" && !has_audio {
        if filter.is_some() && ffmpeg.is_none() {
            // There WAS audio but we can't mux it — save video-only rather than fail.
            eprintln!("export: ffmpeg not found; saving WebM without its audio track");
        }
        return std::fs::write(&path, &bytes).map_err(|e| format!("write {path}: {e}"));
    }

    let ffmpeg = ffmpeg.ok_or(
        "MP4 (and audio) need ffmpeg, which isn't installed. Install it from the export \
         dialog, or choose WebM.",
    )?;

    let tmp = std::env::temp_dir().join(format!("simple_effects_export_{}.webm", std::process::id()));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("temp write: {e}"))?;

    // Both export modes target a bitrate so the output size is predictable and
    // matches the dialog's estimate (size ≈ bitrate × duration):
    //  • "bitrate" — the user's exact bitrate.
    //  • "quality" — the compression level's preset bitrate (1 = near-original …
    //    5 = smallest).
    // We drive x264 in CONSTANT bitrate (CBR), not capped ABR. Plain `-b:v`/
    // `-maxrate` only cap the peak; on compressible content (flat colours, slow
    // motion) x264 undershoots the average badly, so a 600 MB estimate came out
    // ~57 MB and raising the bitrate barely changed the file. Pinning
    // minrate = maxrate = b:v with `nal-hrd=cbr` forces x264 to actually spend the
    // bits, so the output tracks the target and the estimate holds.
    let target = if rate_mode == "bitrate" { bitrate } else { bitrate_for_level(level) }.max(100_000);
    let bv = target.to_string();
    // 1-second VBV buffer → tight CBR that lands on the predicted size.
    let bufsize = target.to_string();

    let mut cmd = quiet_command(&ffmpeg);
    cmd.args(["-y", "-i"]).arg(&tmp);
    // Audio inputs (1..=N).
    for a in &audio {
        cmd.args(["-i"]).arg(&a.path);
    }
    if let Some(fc) = &filter {
        cmd.args(["-filter_complex", fc, "-map", "0:v:0", "-map", "[aout]"]);
    } else {
        cmd.args(["-map", "0:v:0"]);
    }
    // Video codec: keep VP9 for WebM (fast copy), transcode to H.264 for MP4.
    if format == "webm" {
        cmd.args(["-c:v", "copy"]);
        if filter.is_some() {
            cmd.args(["-c:a", "libopus", "-b:a", "192k"]);
        }
    } else {
        cmd.args([
            "-c:v", "libx264",
            "-b:v", bv.as_str(), "-minrate", bv.as_str(), "-maxrate", bv.as_str(),
            "-bufsize", bufsize.as_str(),
            // Force strict CBR so the file actually reaches the target bitrate.
            "-x264-params", "nal-hrd=cbr:force-cfr=1",
            "-preset", "medium", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
        ]);
        if filter.is_some() {
            cmd.args(["-c:a", "aac", "-b:a", "192k"]);
        }
    }
    let result = cmd.arg(&path).output();

    let _ = std::fs::remove_file(&tmp);
    let out = result.map_err(|e| format!("run ffmpeg: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "ffmpeg failed: {}",
            err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("unknown error")
        ));
    }
    Ok(())
}

/// Visit every keyframeable Track on a layer (transform + kind-specific + decal
/// placement + effect params), so delete/clear can act on all of them at once.
/// Shift a layer's whole timing by `delta` ms — its play range and every
/// keyframe — recursing into group children so a group carries its contents when
/// moved. Times are floored at 0.
fn shift_layer_time(layer: &mut Layer, delta: i64) {
    layer.start_ms = (layer.start_ms as i64 + delta).max(0) as u32;
    layer.end_ms = (layer.end_ms as i64 + delta).max(0) as u32;
    for_each_track_mut(layer, |tr| {
        for k in tr.keys.iter_mut() {
            k.time_ms = (k.time_ms as i64 + delta).max(0) as u32;
        }
    });
    if let LayerKind::Group { children } = &mut layer.kind {
        for c in children.iter_mut() {
            shift_layer_time(c, delta);
        }
    }
}

fn for_each_track_mut(layer: &mut Layer, mut f: impl FnMut(&mut Track)) {
    let tf = &mut layer.transform;
    f(&mut tf.x);
    f(&mut tf.y);
    f(&mut tf.scale_x);
    f(&mut tf.scale_y);
    f(&mut tf.rotation);
    f(&mut tf.opacity);
    match &mut layer.kind {
        LayerKind::Text { decompose, parts, .. } => {
            f(decompose);
            for p in parts.iter_mut() {
                f(&mut p.dx);
                f(&mut p.dy);
                f(&mut p.rotation);
                f(&mut p.scale);
            }
        }
        LayerKind::Shape3D {
            width,
            height,
            depth,
            rotation_x,
            rotation_y,
            rotation_z,
            perspective,
            focal_length,
            coverage,
            radius,
            ..
        } => {
            f(width);
            f(height);
            f(depth);
            f(rotation_x);
            f(rotation_y);
            f(rotation_z);
            f(perspective);
            f(focal_length);
            f(coverage);
            f(radius);
        }
        LayerKind::Shape2D { style } => {
            f(&mut style.width);
            f(&mut style.height);
            f(&mut style.sides);
            f(&mut style.corner_radius);
            f(&mut style.bend);
            f(&mut style.border_width);
            f(&mut style.glow_size);
            f(&mut style.glow_opacity);
            f(&mut style.glow_intensity);
            f(&mut style.shadow_blur);
            f(&mut style.shadow_offset_x);
            f(&mut style.shadow_offset_y);
            f(&mut style.shadow_opacity);
        }
        LayerKind::FrameGrid { vertices, cells, linked, .. } => {
            for v in vertices.iter_mut() {
                f(&mut v.dx);
                f(&mut v.dy);
            }
            for cell in cells.iter_mut() {
                f(&mut cell.zoom);
                f(&mut cell.pan_x);
                f(&mut cell.pan_y);
                for e in cell.effects.iter_mut() {
                    walk_effect_tracks(e, &mut f);
                }
            }
            for g in linked.iter_mut() {
                for e in g.effects.iter_mut() {
                    walk_effect_tracks(e, &mut f);
                }
            }
        }
        _ => {}
    }
    if let Some(d) = &mut layer.attach {
        f(&mut d.u);
        f(&mut d.v);
        f(&mut d.scale);
        f(&mut d.rotation);
    }
    for e in &mut layer.effects {
        walk_effect_tracks(e, &mut f);
    }
}

/// Call `f` on each keyframeable `Track` inside one effect (shared by layer-level
/// and per-cell effect stacks).
fn walk_effect_tracks(e: &mut Effect, f: &mut dyn FnMut(&mut Track)) {
    match e {
        Effect::Grayscale { amount }
        | Effect::Brightness { amount }
        | Effect::Contrast { amount }
        | Effect::Saturate { amount }
        | Effect::Invert { amount } => f(amount),
        Effect::Blur { radius } => f(radius),
        Effect::Hue { degrees } => f(degrees),
        Effect::Wipe { position, softness, .. } => {
            f(position);
            f(softness);
        }
        Effect::ShinyClouds {
            intensity, scale, speed, complexity, contrast, brightness, opacity, ..
        } => {
            f(intensity);
            f(scale);
            f(speed);
            f(complexity);
            f(contrast);
            f(brightness);
            f(opacity);
        }
        Effect::GpuOverlay {
            intensity, scale, speed, detail, softness, extra, opacity, ..
        } => {
            f(intensity);
            f(scale);
            f(speed);
            f(detail);
            f(softness);
            f(extra);
            f(opacity);
        }
    }
}

/// Duplicate a layer (copy/paste): deep-clone it with a fresh id, named "… copy",
/// inserted just above the original (so it's drawn on top and ready to edit).
/// Text layers are re-shaped into the cache. Undoable.
#[tauri::command]
fn duplicate_layer(state: State<AppState>, layer_id: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let idx = project
        .layers
        .iter()
        .position(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    let mut next = max_layer_id(&project.layers) + 1;
    let mut clone = project.layers[idx].clone();
    reassign_ids(&mut clone, &mut next); // fresh ids for it + any nested children
    clone.name = format!("{} copy", clone.name);
    project.layers.insert(idx + 1, clone);
    reshape_recursive(&mut state.shaped.lock().unwrap(), &project.layers[idx + 1]);
    Ok(project.clone())
}

/// Split ("cut") a layer at `t_ms` into two independent segments: the original
/// keeps [start_ms, t_ms] and a fresh clone takes [t_ms, end_ms] (same
/// keyframes / effects / transitions). The transition at the cut boundary is
/// dropped on both sides. No-op unless start_ms < t_ms < end_ms. Undoable.
#[tauri::command]
fn split_layer(state: State<AppState>, layer_id: u32, t_ms: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    let idx = project
        .layers
        .iter()
        .position(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    {
        let l = &project.layers[idx];
        if t_ms <= l.start_ms || t_ms >= l.end_ms {
            return Err("cut point must be inside the layer".into());
        }
    }
    state.snapshot(&project);
    let mut next = max_layer_id(&project.layers) + 1;
    let mut second = project.layers[idx].clone();
    reassign_ids(&mut second, &mut next); // fresh ids for it + any nested children
    second.start_ms = t_ms;
    second.transition_in = None; // it now starts mid-clip
    project.layers[idx].end_ms = t_ms;
    project.layers[idx].transition_out = None; // it now ends at the cut
    project.layers.insert(idx + 1, second);
    reshape_recursive(&mut state.shaped.lock().unwrap(), &project.layers[idx + 1]);
    Ok(project.clone())
}

/// Delete a layer (object). If it's a shape, any layers pinned to it are detached
/// back to flat. Undoable.
#[tauri::command]
fn delete_layer(state: State<AppState>, layer_id: u32) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let is_shape = project
        .layers
        .iter()
        .any(|l| l.id == layer_id && matches!(l.kind, LayerKind::Shape3D { .. }));
    if is_shape {
        for l in &mut project.layers {
            if l.attach.as_ref().map_or(false, |d| d.shape_id == layer_id) {
                l.attach = None;
            }
        }
    }
    project.layers.retain(|l| l.id != layer_id);
    state.shaped.lock().unwrap().remove(&layer_id);
    project.clone()
}

/// Remove every keyframe at exactly `t_ms` across all of a layer's tracks
/// (deleting the "keys" the timeline shows as one diamond). Undoable.
#[tauri::command]
fn delete_keyframes_at(
    state: State<AppState>,
    layer_id: u32,
    t_ms: u32,
) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    for_each_track_mut(layer, |tr| tr.keys.retain(|k| k.time_ms != t_ms));
    Ok(project.clone())
}

/// Clear ALL keyframes on a layer (delete its animation tracks), freezing each
/// property at its value at `t_ms` so the look doesn't jump. Undoable.
#[tauri::command]
fn clear_keyframes(state: State<AppState>, layer_id: u32, t_ms: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    for_each_track_mut(layer, |tr| {
        tr.default = eval::sample_track(tr, t_ms);
        tr.keys.clear();
    });
    Ok(project.clone())
}

/// Clear all manual per-glyph overrides on a text layer.
#[tauri::command]
fn clear_letter_overrides(state: State<AppState>, layer_id: u32) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Text { parts, .. } => parts.clear(),
        _ => return Err("not a text layer".into()),
    }
    Ok(project.clone())
}

/// Read an image off disk and return it as a `data:` URL the webview can load
/// directly into a Konva image. Keeps file access in Rust (no fs-plugin scope
/// to configure) at the cost of base64 over IPC — fine for preview-sized images.
#[tauri::command]
fn load_image_data_url(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let mime = match std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Open with a clear timeline (no default layers).
            let project = Project::empty();
            let mut shaped = HashMap::new();
            for l in &project.layers {
                reshape_layer(&mut shaped, l);
            }
            app.manage(AppState {
                project: Mutex::new(project),
                shaped: Mutex::new(shaped),
                history: Mutex::new(History::default()),
                nav: Mutex::new(Vec::new()),
                launch_file: Mutex::new(launch_file_from_args()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_project,
            set_project,
            set_media,
            new_project,
            take_launch_file,
            evaluate_at,
            add_image_layer,
            add_video_layer,
            add_audio_layer,
            place_layer,
            combine_layers,
            explode_layer,
            enter_group,
            exit_group,
            nav_depth,
            edit_keyframes,
            set_layer_hidden,
            set_letter_override,
            set_letter_color,
            clear_letter_color,
            scale_layer_to_fit,
            clear_letter_overrides,
            set_decompose_key,
            add_shape_layer,
            add_shape2d_layer,
            create_cylinder_carousel,
            create_box_carousel,
            create_photo_grid,
            create_grid_call,
            create_slideshow_template,
            create_carousel_video,
            create_mixed_video,
            rename_layer,
            set_text_align,
            set_shape2d,
            add_frame_grid,
            filter_existing_files,
            set_cell_image,
            set_grid_background,
            clear_grid_background,
            clear_cell_image,
            set_cell_zoom,
            set_grid_vertices,
            set_grid_constrain,
            set_grid_line_width,
            set_grid_line_color,
            clear_grid_line_color,
            merge_cell,
            split_cell,
            set_cell_transition,
            set_all_cells_transition,
            add_cell_effect,
            remove_cell_effect,
            key_cell_effect,
            set_cell_wipe_static,
            set_cell_shine_static,
            set_cell_gpufx_static,
            set_cell_pan,
            paste_cell_effects,
            paste_cell_effects_all,
            move_cell_keyframes_at,
            delete_cell_keyframes_at,
            link_effect,
            add_linked_effect,
            remove_linked_effect_item,
            key_linked_effect,
            set_linked_wipe_static,
            remove_linked_group,
            set_linked_member,
            unlink_cell,
            set_shape_params,
            set_shape_rotation_key,
            attach_to_shape,
            key_decal,
            set_decal_face,
            drop_image_on_shape,
            add_effect,
            remove_effect,
            key_effect,
            set_wipe_static,
            set_shine_static,
            set_gpufx_static,
            save_binary_file,
            delete_layer,
            delete_keyframes_at,
            clear_keyframes,
            set_comp_size,
            set_comp_duration,
            set_comp_fps,
            set_layer_range,
            move_keyframes_at,
            set_layer_transition,
            duplicate_layer,
            split_layer,
            reorder_layers,
            save_project_file,
            open_project_file,
            ffmpeg_status,
            install_ffmpeg,
            export_video,
            add_text_layer,
            add_adjustment_layer,
            set_text_content,
            set_text_color,
            clear_text_color_keys,
            set_text_font,
            set_text_font_style,
            set_text_anim,
            list_fonts,
            font_styles,
            set_text_style,
            set_text_animators,
            set_text_layer_styles,
            set_text_per_char_3d,
            get_shaped,
            load_image_data_url,
            undo,
            redo,
            save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod mixed_tests {
    use super::*;

    fn ctx() -> VCtx {
        VCtx { cw: 1920.0, ch: 1080.0, cx: 960.0, cy: 540.0, comp_min: 1080.0 }
    }
    fn imgs(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("nonexistent_{i}.png")).collect()
    }

    #[test]
    fn segment_builders_do_not_panic() {
        for kind in ["cylinder", "box", "grid"] {
            let c = ctx();
            let mut next = 1u32;
            let mut layers = Vec::new();
            let mut caps = Vec::new();
            let end = v_feature_segment(kind, &c, &imgs(5), 0, 5 * 1500, 800, &mut next, &mut layers, &mut caps);
            assert!(end > 0, "{kind} segment should advance time");
            assert!(!layers.is_empty(), "{kind} segment should add layers");
        }
    }

    #[test]
    fn plain_segment_builds() {
        let c = ctx();
        let mut next = 1u32;
        let mut layers = Vec::new();
        let mut caps = Vec::new();
        let end = v_plain_segment(&c, &imgs(3), 0, 3 * 1500, 800, &mut next, &mut layers, &mut caps);
        assert!(end > 0);
        assert!(layers.len() >= 3);
    }
}
