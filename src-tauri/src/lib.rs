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
    ColorKey, ConstrainMode, Decal, Easing, Effect, FrameCell, GridVertex, Keyframe, Layer,
    LayerKind, LetterAnimation, LetterOverride, LinkedEffectGroup, Project, Rgba, SurfaceShape,
    Track, Transform, TransformEdit, Transition, TransitionKind,
};
use text::{Font, ShapedText};

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
    if let LayerKind::Text { content, size, font, .. } = &layer.kind {
        shaped.insert(layer.id, text::shape(content, *size, font));
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
        .map(|(id, st)| (*id, (st.width, st.ascender + st.descender)))
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
    let shaped = text::shape(&content, size, &font);
    project.layers.push(Layer {
        id: next_id,
        name: "Text".into(),
        start_ms: 0,
        end_ms,
        kind: LayerKind::Text {
            content,
            size,
            color: Rgba { r: 245, g: 245, b: 250, a: 255 },
            color_keys: vec![],
            font,
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

/// Add an adjustment layer spanning the whole comp, seeded with one "shiny
/// clouds" effect. Its effect stack (layer.effects) lights every layer below it.
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
        effects: vec![Effect::default_of("shinyclouds").unwrap()],
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
    let font = match &mut layer.kind {
        LayerKind::Text { content: c, size: s, font, .. } => {
            *c = content.clone();
            *s = size;
            font.clone()
        }
        _ => return Err("not a text layer".into()),
    };
    state
        .shaped
        .lock()
        .unwrap()
        .insert(layer_id, text::shape(&content, size, &font));
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
    let (content, size) = {
        let layer = project
            .layers
            .iter_mut()
            .find(|l| l.id == layer_id)
            .ok_or("layer not found")?;
        match &mut layer.kind {
            LayerKind::Text { content, size, font: f, .. } => {
                *f = font.clone();
                (content.clone(), *size)
            }
            _ => return Err("not a text layer".into()),
        }
    };
    state
        .shaped
        .lock()
        .unwrap()
        .insert(layer_id, text::shape(&content, size, &font));
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
        kind: LayerKind::Image { src: path, width: iw, height: ih },
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
fn set_comp_fps(state: State<AppState>, fps: u32) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    project.fps = fps.clamp(1, 240);
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
            width: w,
            height: h,
            depth: w.min(h) * 0.7,
            rotation_x: Track::constant(0.0),
            rotation_y: Track::constant(0.0),
            rotation_z: Track::constant(0.0),
            perspective: 0.35,
            focal_length: 1200.0,
            coverage: 360.0,
            radius: w.min(h) * 0.5,
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

/// Set a `Shape3D` layer's static parameters (dimensions + camera). Rotations are
/// keyframed separately (`set_shape_rotation_key`). Undoable.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn set_shape_params(
    state: State<AppState>,
    layer_id: u32,
    width: f32,
    height: f32,
    depth: f32,
    perspective: f32,
    focal_length: f32,
    coverage: f32,
    radius: f32,
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
            *w = width.max(1.0);
            *h = height.max(1.0);
            *d = depth.max(0.0);
            *p = perspective.clamp(0.0, 1.0);
            *f = focal_length.max(50.0);
            *c = coverage.clamp(1.0, 360.0);
            *r = radius.max(1.0);
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

/// Locate an `ffmpeg` executable. Checks PATH first, then the locations winget
/// installs to (its running-process PATH isn't refreshed after an install), then
/// a couple of common spots.
fn find_ffmpeg() -> Option<std::path::PathBuf> {
    // On PATH?
    if std::process::Command::new("ffmpeg")
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
    let out = std::process::Command::new("winget")
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

/// Save the exported video. `webm_base64` is the recorded WebM. `format` "webm"
/// writes it as-is; "mp4" transcodes to H.264 via ffmpeg. `level` 1..5 sets the
/// compression (1 = near-original / largest, 5 = highest compression / smallest).
#[tauri::command]
fn export_video(
    webm_base64: String,
    path: String,
    format: String,
    level: u8,
) -> Result<(), String> {
    let bytes = STANDARD
        .decode(webm_base64.as_bytes())
        .map_err(|e| format!("decode: {e}"))?;
    if format == "webm" {
        return std::fs::write(&path, &bytes).map_err(|e| format!("write {path}: {e}"));
    }
    // MP4 (H.264) via ffmpeg.
    let ffmpeg = find_ffmpeg().ok_or(
        "MP4 needs ffmpeg, which isn't installed. Install it from the export dialog, \
         or choose WebM.",
    )?;
    let crf = match level {
        1 => "16",
        2 => "20",
        3 => "23",
        4 => "27",
        _ => "32",
    };
    let tmp = std::env::temp_dir().join(format!("simple_effects_export_{}.webm", std::process::id()));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("temp write: {e}"))?;
    let result = std::process::Command::new(&ffmpeg)
        .args(["-y", "-i"])
        .arg(&tmp)
        .args([
            "-c:v", "libx264", "-crf", crf, "-preset", "medium", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
        ])
        .arg(&path)
        .output();
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
        LayerKind::Shape3D { rotation_x, rotation_y, rotation_z, .. } => {
            f(rotation_x);
            f(rotation_y);
            f(rotation_z);
        }
        LayerKind::FrameGrid { vertices, cells, linked, .. } => {
            for v in vertices.iter_mut() {
                f(&mut v.dx);
                f(&mut v.dy);
            }
            for cell in cells.iter_mut() {
                f(&mut cell.zoom);
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
            add_frame_grid,
            set_cell_image,
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
            set_text_anim,
            list_fonts,
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
