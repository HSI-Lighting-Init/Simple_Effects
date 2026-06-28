//! Tauri command surface for the animation tool.
//!
//! The project lives in a single `Mutex<Project>` owned by Tauri state. The
//! frontend reads structure once with `get_project` and asks for resolved
//! transforms per playhead time with `evaluate_at`.

mod eval;
mod model;
mod text;

use std::collections::HashMap;
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::{Manager, State};

use eval::ResolvedLayer;
use model::{
    Easing, Keyframe, Layer, LayerKind, LetterAnimation, LetterOverride, Project, Rgba, Track,
    Transform, TransformEdit,
};
use text::{Font, ShapedText};

/// Undo/redo stacks of whole-project snapshots. Each user-level mutation pushes
/// the pre-change project onto `undo`.
#[derive(Default)]
struct History {
    undo: Vec<Project>,
    redo: Vec<Project>,
}

/// App-wide mutable state. `shaped` caches the shaped glyphs per text layer so we
/// don't re-shape every frame; it's rebuilt whenever a layer's text changes.
/// Lock order is always project → history → shaped to avoid deadlock.
struct AppState {
    project: Mutex<Project>,
    shaped: Mutex<HashMap<u32, ShapedText>>,
    history: Mutex<History>,
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
        shaped.insert(layer.id, text::shape(content, *size, *font));
    }
}

/// Rebuild the whole shaping cache from a project (after undo/redo/load).
fn reshape_all(project: &Project, shaped: &mut HashMap<u32, ShapedText>) {
    shaped.clear();
    for l in &project.layers {
        reshape_layer(shaped, l);
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
    eval::evaluate(&project, t_ms, &counts)
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
    let next_id = project.layers.iter().map(|l| l.id).max().unwrap_or(0) + 1;
    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    let end_ms = project.duration_ms;
    let font = Font::Vazirmatn;
    let shaped = text::shape(&content, size, font);
    project.layers.push(Layer {
        id: next_id,
        name: "Text".into(),
        start_ms: 0,
        end_ms,
        kind: LayerKind::Text {
            content,
            size,
            color: Rgba { r: 245, g: 245, b: 250, a: 255 },
            font,
            anim: None,
            parts: vec![],
            decompose: Track::constant(0.0),
        },
        transform: Transform::at(cx, cy),
        hidden: false,
    });
    state.shaped.lock().unwrap().insert(next_id, shaped);
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
            *font
        }
        _ => return Err("not a text layer".into()),
    };
    state
        .shaped
        .lock()
        .unwrap()
        .insert(layer_id, text::shape(&content, size, font));
    Ok(project.clone())
}

/// Change a text layer's fill colour (no reshape needed).
#[tauri::command]
fn set_text_color(state: State<AppState>, layer_id: u32, color: Rgba) -> Result<Project, String> {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let layer = project
        .layers
        .iter_mut()
        .find(|l| l.id == layer_id)
        .ok_or("layer not found")?;
    match &mut layer.kind {
        LayerKind::Text { color: c, .. } => *c = color,
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
                *f = font;
                (content.clone(), *size)
            }
            _ => return Err("not a text layer".into()),
        }
    };
    state
        .shaped
        .lock()
        .unwrap()
        .insert(layer_id, text::shape(&content, size, font));
    Ok(project.clone())
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

/// Append an image layer pointing at an absolute path, returning the new project.
#[tauri::command]
fn add_image_layer(state: State<AppState>, path: String) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let next_id = project.layers.iter().map(|l| l.id).max().unwrap_or(0) + 1;
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Image".into());
    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    let end_ms = project.duration_ms;

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
    });
    project.clone()
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

/// Set the manual transform for one glyph of a text layer (decompose mode). The
/// `parts` vec is grown to the shaped glyph count on demand.
#[tauri::command]
fn set_letter_override(
    state: State<AppState>,
    layer_id: u32,
    index: usize,
    part: LetterOverride,
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
    match &mut layer.kind {
        LayerKind::Text { parts, .. } => {
            if parts.len() < count {
                parts.resize(count, LetterOverride::default());
            }
            if let Some(slot) = parts.get_mut(index) {
                *slot = part;
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
            let project = Project::demo();
            let mut shaped = HashMap::new();
            for l in &project.layers {
                reshape_layer(&mut shaped, l);
            }
            app.manage(AppState {
                project: Mutex::new(project),
                shaped: Mutex::new(shaped),
                history: Mutex::new(History::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_project,
            set_project,
            evaluate_at,
            add_image_layer,
            edit_keyframes,
            set_layer_hidden,
            set_letter_override,
            clear_letter_overrides,
            set_decompose_key,
            add_text_layer,
            set_text_content,
            set_text_color,
            set_text_font,
            set_text_anim,
            get_shaped,
            load_image_data_url,
            undo,
            redo,
            save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
