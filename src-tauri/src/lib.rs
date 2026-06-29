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
    Decal, Easing, Effect, Keyframe, Layer, LayerKind, LetterAnimation, LetterOverride, Project,
    Rgba, SurfaceShape, Track, Transform, TransformEdit,
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
        attach: None,
        effects: vec![],
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
        attach: None,
        effects: vec![],
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

/// Add an invisible 3D box/cylinder object centred in the comp. Images can then
/// be pinned to it (`attach_image`) to render as decals on its surface.
#[tauri::command]
fn add_shape_layer(state: State<AppState>, shape: SurfaceShape) -> Project {
    let mut project = state.project.lock().unwrap();
    state.snapshot(&project);
    let next_id = project.layers.iter().map(|l| l.id).max().unwrap_or(0) + 1;
    let (cx, cy) = (project.width as f32 / 2.0, project.height as f32 / 2.0);
    let end_ms = project.duration_ms;
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
    });
    project.clone()
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
        LayerKind::Text { decompose, .. } => f(decompose),
        LayerKind::Shape3D { rotation_x, rotation_y, rotation_z, .. } => {
            f(rotation_x);
            f(rotation_y);
            f(rotation_z);
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
        }
    }
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
            add_shape_layer,
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
            save_binary_file,
            delete_layer,
            delete_keyframes_at,
            clear_keyframes,
            set_comp_size,
            ffmpeg_status,
            install_ffmpeg,
            export_video,
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
