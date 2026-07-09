//! The authoritative animation evaluator.
//!
//! The preview (Konva) and the export pipeline (tiny-skia) BOTH call this code,
//! so what you see is what you render. The frontend asks for resolved transforms
//! over IPC (`evaluate_at`) rather than re-implementing easing in TypeScript —
//! one copy of the math, no preview/export drift.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{
    AnimSelector, ColorKey, Easing, Effect, FitMode, GridVertex, Layer, LayerKind, LetterAnimation,
    LetterPreset, LinkedEffectGroup, Project, RangeShape, Rgba, SelectorKind, Shape2DStyle,
    TextAnimator, Track, TransitionKind, VectorShape,
};
use crate::surface::{self, QuadVertex, ResolvedShapeFrame, ResolvedSurface, ShapeState, SurfaceQuad, Vec2};

/// A layer's transform fully resolved at one instant in time. Field names are
/// camelCase so they map straight onto Konva node props on the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ResolvedLayer {
    pub id: u32,
    /// Whether the layer is within its [startMs, endMs] range at this time.
    pub visible: bool,
    pub x: f32,
    pub y: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    pub rotation: f32,
    pub opacity: f32,
    /// Per-letter offsets for animated `Text` layers (one per shaped glyph,
    /// in glyph order). Empty for everything else.
    pub letters: Vec<LetterTransform>,
    /// Text fill colour sampled at this time (interpolated from `color_keys`, or
    /// the static fill when the layer isn't keyed). `None` for non-text layers.
    pub color: Option<Rgba>,
    /// Paint-ready decal quads when this is an image pinned to a `Shape3D`.
    /// `None` = render the image flat.
    pub surface: Option<ResolvedSurface>,
    /// Visible-face polygons when this is a `Shape3D` layer (for the selection
    /// wireframe + hit area). `None` for everything else.
    pub shape: Option<ResolvedShapeFrame>,
    /// The layer's effect stack with every parameter sampled at this time, in
    /// apply order. Empty when the layer has no effects.
    pub effects: Vec<ResolvedEffect>,
    /// Active in/out transition at this time (factor 0 = fully transitioned /
    /// hidden, 1 = fully present). `None` outside any transition window.
    pub transition: Option<ResolvedTransition>,
    /// Resolved multi-frame grid (cells + warped lattice) when this is a
    /// `FrameGrid` layer. `None` for everything else.
    pub frame_grid: Option<ResolvedFrameGrid>,
    /// Resolved child layers when this is a `Group` (precomp) — the frontend
    /// renders them nested under this layer's transform. `None` otherwise.
    pub group: Option<ResolvedGroup>,
    /// Resolved 2D vector shape (fill/border/glow/shadow, every colour + knob
    /// sampled at this time) when this is a `Shape2D` layer. `None` otherwise.
    pub shape2d: Option<ResolvedShape2D>,
}

/// A `Shape2D` resolved at one instant: the geometry plus every paint property
/// sampled at this time (colours interpolated from their key lists, numeric
/// knobs from their tracks). camelCase → Konva-friendly on the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ResolvedShape2D {
    pub shape: VectorShape,
    pub width: f32,
    pub height: f32,
    pub sides: u32,
    pub corner_radius: f32,
    /// Arrow curvature (px). 0 = straight.
    pub bend: f32,
    /// false = hollow (outline only).
    pub filled: bool,
    pub fill: Rgba,
    pub border_width: f32,
    pub border_color: Rgba,
    pub glow_color: Rgba,
    pub glow_size: f32,
    pub glow_opacity: f32,
    pub shadow_color: Rgba,
    pub shadow_blur: f32,
    pub shadow_offset_x: f32,
    pub shadow_offset_y: f32,
    pub shadow_opacity: f32,
}

/// Sample every keyframeable property of a `Shape2D` style at `t_ms`.
fn resolve_shape2d(s: &Shape2DStyle, t_ms: u32) -> ResolvedShape2D {
    ResolvedShape2D {
        shape: s.shape,
        width: sample_track(&s.width, t_ms).max(1.0),
        height: sample_track(&s.height, t_ms).max(1.0),
        sides: (sample_track(&s.sides, t_ms).round() as i64).max(3) as u32,
        corner_radius: sample_track(&s.corner_radius, t_ms).max(0.0),
        bend: sample_track(&s.bend, t_ms),
        filled: s.filled,
        fill: sample_color(&s.fill_keys, s.fill, t_ms),
        border_width: sample_track(&s.border_width, t_ms).max(0.0),
        border_color: sample_color(&s.border_color_keys, s.border_color, t_ms),
        glow_color: sample_color(&s.glow_color_keys, s.glow_color, t_ms),
        glow_size: sample_track(&s.glow_size, t_ms).max(0.0),
        glow_opacity: sample_track(&s.glow_opacity, t_ms).clamp(0.0, 1.0),
        shadow_color: sample_color(&s.shadow_color_keys, s.shadow_color, t_ms),
        shadow_blur: sample_track(&s.shadow_blur, t_ms).max(0.0),
        shadow_offset_x: sample_track(&s.shadow_offset_x, t_ms),
        shadow_offset_y: sample_track(&s.shadow_offset_y, t_ms),
        shadow_opacity: sample_track(&s.shadow_opacity, t_ms).clamp(0.0, 1.0),
    }
}

/// A nested composition resolved at one instant: its child layers, each already
/// resolved (recursively) at the same comp time.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ResolvedGroup {
    pub children: Vec<ResolvedLayer>,
}

/// A `FrameGrid` resolved at one instant: the (possibly warped) vertex lattice
/// plus one paint-ready cell per grid cell. Geometry is in LAYER-LOCAL px
/// (centred on the origin); the frontend draws it under the layer's transform.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ResolvedFrameGrid {
    pub rows: u32,
    pub cols: u32,
    /// The lattice in layer-local px (row-major, (rows+1)*(cols+1)) — for the
    /// mesh overlay + editing handles.
    pub vertices: Vec<Vec2>,
    pub cells: Vec<ResolvedFrameCell>,
    /// Shared effect groups (for the inspector's linked-effects UI). Their
    /// effects are already folded into each member cell's `effects`.
    pub linked: Vec<ResolvedLinkedEffect>,
    /// Grid line thickness (layer-local px) and colour sampled at this time.
    pub line_width: f32,
    pub line_color: Rgba,
    /// Shared background image spanning the grid (each cell shows its slice).
    pub background: Option<String>,
}

/// A linked effect group resolved at this time (its shared stack + members).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ResolvedLinkedEffect {
    pub id: u32,
    pub effects: Vec<ResolvedEffect>,
    pub members: Vec<u32>,
}

/// One resolved grid cell: a flat local-space quad (hw = 1), its image source +
/// natural size, fit mode, and its effect stack sampled at this time.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ResolvedFrameCell {
    pub quad: SurfaceQuad,
    pub src: Option<String>,
    pub img_w: f32,
    pub img_h: f32,
    pub fit: FitMode,
    /// Zoom sampled at this time (for the inspector's slider readout).
    pub zoom: f32,
    /// Image pan within the cell (fractions of the cell) sampled at this time.
    pub pan_x: f32,
    pub pan_y: f32,
    /// Grid position + merge spans (so the frontend can map a cell back to its
    /// lattice vertices for live-warp, and know its size).
    pub row: u32,
    pub col: u32,
    pub row_span: u32,
    pub col_span: u32,
    /// True when this slot is absorbed into another cell's merged block — the
    /// frontend skips it (no draw, no gridline, not clickable).
    pub covered: bool,
    pub effects: Vec<ResolvedEffect>,
    /// The cell's active in/out transition at this time (played over the grid
    /// layer's start/end). `None` outside any window.
    pub transition: Option<ResolvedTransition>,
}

/// Resolve a `FrameGrid` at `t_ms`: sample each vertex's warp offset, build the
/// local-space lattice, and emit one quad per cell (with UVs adjusted for the
/// cell's fit mode). `cells`/`vertices` shorter than expected are padded with
/// defaults so a freshly-created grid (empty `vertices`) renders a regular mesh.
#[allow(clippy::too_many_arguments)]
fn resolve_frame_grid(
    rows: u32,
    cols: u32,
    cell_w: f32,
    cell_h: f32,
    vertices: &[GridVertex],
    cells: &[crate::model::FrameCell],
    linked: &[LinkedEffectGroup],
    line_width: f32,
    line_color: Rgba,
    line_color_keys: &[ColorKey],
    background: &Option<String>,
    layer_start: u32,
    layer_end: u32,
    t_ms: u32,
) -> ResolvedFrameGrid {
    let vcols = cols + 1;
    let vrows = rows + 1;
    let grid_w = cols as f32 * cell_w;
    let grid_h = rows as f32 * cell_h;
    // Vertex positions in local space (centred), with the sampled warp offset.
    let mut pts: Vec<Vec2> = Vec::with_capacity((vrows * vcols) as usize);
    for r in 0..vrows {
        for c in 0..vcols {
            let base_x = c as f32 * cell_w - grid_w / 2.0;
            let base_y = r as f32 * cell_h - grid_h / 2.0;
            let (dx, dy) = vertices
                .get((r * vcols + c) as usize)
                .map(|gv| (sample_track(&gv.dx, t_ms), sample_track(&gv.dy, t_ms)))
                .unwrap_or((0.0, 0.0));
            pts.push(Vec2 { x: base_x + dx, y: base_y + dy });
        }
    }

    // Merge layout: which slots are covered, and each master's effective spans.
    let (covered, spans) = crate::model::grid_layout(rows, cols, cells);

    // Resolve the shared linked groups once (same for every member).
    let resolved_linked: Vec<ResolvedLinkedEffect> = linked
        .iter()
        .map(|g| ResolvedLinkedEffect {
            id: g.id,
            effects: g.effects.iter().map(|e| resolve_effect(e, t_ms)).collect(),
            members: g.members.clone(),
        })
        .collect();

    let mut out_cells: Vec<ResolvedFrameCell> = Vec::with_capacity((rows * cols) as usize);
    for r in 0..rows {
        for c in 0..cols {
            let idx = (r * cols + c) as usize;
            if covered[idx] {
                // Absorbed into a merged block → a placeholder the frontend skips.
                out_cells.push(ResolvedFrameCell {
                    quad: SurfaceQuad { corners: Vec::new(), opacity: 0.0, subdiv: 1 },
                    src: None,
                    img_w: 0.0,
                    img_h: 0.0,
                    fit: FitMode::Cover,
                    zoom: 1.0,
                    pan_x: 0.0,
                    pan_y: 0.0,
                    row: r,
                    col: c,
                    row_span: 1,
                    col_span: 1,
                    covered: true,
                    effects: Vec::new(),
                    transition: None,
                });
                continue;
            }
            let (rs, cs) = spans[idx];
            // Block outer corners from the lattice (spanning merged slots).
            let tl = pts[(r * vcols + c) as usize];
            let tr = pts[(r * vcols + c + cs) as usize];
            let br = pts[((r + rs) * vcols + c + cs) as usize];
            let bl = pts[((r + rs) * vcols + c) as usize];
            let cell = cells.get(idx);
            #[allow(clippy::type_complexity)]
            let (src, img_w, img_h, fit, zoom, pan_x, pan_y, mut effects): (
                _,
                _,
                _,
                _,
                _,
                f32,
                f32,
                Vec<ResolvedEffect>,
            ) = match cell {
                Some(cell) => (
                    cell.src.clone(),
                    cell.img_w as f32,
                    cell.img_h as f32,
                    cell.fit,
                    sample_track(&cell.zoom, t_ms),
                    sample_track(&cell.pan_x, t_ms),
                    sample_track(&cell.pan_y, t_ms),
                    cell.effects.iter().map(|e| resolve_effect(e, t_ms)).collect(),
                ),
                None => (None, 0.0, 0.0, FitMode::Cover, 1.0, 0.0, 0.0, Vec::new()),
            };
            // Fold in every linked group this cell belongs to (after its local stack).
            for g in &resolved_linked {
                if g.members.contains(&(idx as u32)) {
                    effects.extend(g.effects.iter().cloned());
                }
            }
            let cell_transition = cell.and_then(|c| {
                resolve_transition_windows(&c.transition_in, &c.transition_out, layer_start, layer_end, t_ms)
            });
            // Fit against the merged block's aspect, then apply zoom, then pan the
            // UV window (in fractions of the cell) to reposition the image.
            let block_w = cs as f32 * cell_w;
            let block_h = rs as f32 * cell_h;
            let (mut u0, mut v0, mut u1, mut v1) =
                zoom_uvs(fit_uvs(fit, block_w, block_h, img_w, img_h), zoom);
            let pw = u1 - u0;
            let ph = v1 - v0;
            u0 -= pan_x * pw;
            u1 -= pan_x * pw;
            v0 -= pan_y * ph;
            v1 -= pan_y * ph;
            let corners = vec![
                QuadVertex { hx: tl.x, hy: tl.y, hw: 1.0, u: u0, v: v0 },
                QuadVertex { hx: tr.x, hy: tr.y, hw: 1.0, u: u1, v: v0 },
                QuadVertex { hx: br.x, hy: br.y, hw: 1.0, u: u1, v: v1 },
                QuadVertex { hx: bl.x, hy: bl.y, hw: 1.0, u: u0, v: v1 },
            ];
            out_cells.push(ResolvedFrameCell {
                quad: SurfaceQuad { corners, opacity: 1.0, subdiv: 3 },
                src,
                img_w,
                img_h,
                fit,
                zoom,
                pan_x,
                pan_y,
                row: r,
                col: c,
                row_span: rs,
                col_span: cs,
                covered: false,
                effects,
                transition: cell_transition,
            });
        }
    }
    let line_color = sample_color(line_color_keys, line_color, t_ms);
    ResolvedFrameGrid {
        rows,
        cols,
        vertices: pts,
        cells: out_cells,
        linked: resolved_linked,
        line_width,
        line_color,
        background: background.clone(),
    }
}

/// Scale a UV sub-rect about its centre by `zoom` (>1 = zoom in / crop tighter,
/// <1 = zoom out). The window shrinks by 1/zoom so the image appears larger.
fn zoom_uvs(uv: (f32, f32, f32, f32), zoom: f32) -> (f32, f32, f32, f32) {
    let z = zoom.max(0.01);
    let (u0, v0, u1, v1) = uv;
    let cu = (u0 + u1) / 2.0;
    let cv = (v0 + v1) / 2.0;
    let hu = (u1 - u0) / 2.0 / z;
    let hv = (v1 - v0) / 2.0 / z;
    (cu - hu, cv - hv, cu + hu, cv + hv)
}

/// Texture UV sub-rect (u0,v0,u1,v1) for a fit mode. Cover crops the longer axis;
/// contain would need transparent margins (handled renderer-side) so it maps the
/// full texture like stretch here and the renderer letterboxes.
fn fit_uvs(fit: FitMode, cell_w: f32, cell_h: f32, img_w: f32, img_h: f32) -> (f32, f32, f32, f32) {
    if img_w <= 0.0 || img_h <= 0.0 || cell_w <= 0.0 || cell_h <= 0.0 {
        return (0.0, 0.0, 1.0, 1.0);
    }
    match fit {
        FitMode::Stretch | FitMode::Contain => (0.0, 0.0, 1.0, 1.0),
        FitMode::Cover => {
            let cell_a = cell_w / cell_h;
            let img_a = img_w / img_h;
            if img_a > cell_a {
                // Image is wider than the cell → crop left/right.
                let keep = cell_a / img_a; // fraction of width to keep
                let m = (1.0 - keep) / 2.0;
                (m, 0.0, 1.0 - m, 1.0)
            } else {
                // Image is taller → crop top/bottom.
                let keep = img_a / cell_a; // fraction of height to keep
                let m = (1.0 - keep) / 2.0;
                (0.0, m, 1.0, 1.0 - m)
            }
        }
    }
}

/// A layer's in/out transition resolved at a point in time.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ResolvedTransition {
    pub kind: TransitionKind,
    /// 0 = fully transitioned-out, 1 = fully present (eased).
    pub factor: f32,
    pub direction: u8,
    /// Frontend transition-engine id to render, if the transition uses one.
    pub engine: Option<String>,
    /// Engine transition variables (JSON object string), passed to the renderer.
    pub params: Option<String>,
}

/// Resolve a layer's active transition (in or out) at `t_ms`, if any.
fn resolve_transition(layer: &crate::model::Layer, t_ms: u32) -> Option<ResolvedTransition> {
    resolve_transition_windows(&layer.transition_in, &layer.transition_out, layer.start_ms, layer.end_ms, t_ms)
}

/// Resolve an in/out transition pair over the window [`start_ms`, `end_ms`] at
/// `t_ms`. Shared by layer transitions and per-cell grid transitions. When both
/// windows overlap, the more-transitioned (smaller factor) one wins.
fn resolve_transition_windows(
    transition_in: &Option<crate::model::Transition>,
    transition_out: &Option<crate::model::Transition>,
    start_ms: u32,
    end_ms: u32,
    t_ms: u32,
) -> Option<ResolvedTransition> {
    let mut factor = 2.0f32; // sentinel above any real factor
    let mut kind = None;
    let mut direction = 0u8;
    let mut engine: Option<String> = None;
    let mut params: Option<String> = None;
    // A transition can't be longer than the clip it plays over, or it never
    // finishes (progress stays near 0) and you only ever see its opening — which
    // reads as a slow fade. Clamp each window to the span.
    let span = end_ms.saturating_sub(start_ms).max(1);
    if let Some(ti) = transition_in {
        let dur = ti.dur_ms.min(span);
        if dur > 0 && t_ms < start_ms + dur {
            let u = t_ms.saturating_sub(start_ms) as f32 / dur as f32;
            let f = ease(Easing::EaseInOut, u);
            if f < factor {
                factor = f;
                kind = Some(ti.kind);
                direction = ti.direction;
                engine = ti.engine.clone();
                params = ti.params.clone();
            }
        }
    }
    if let Some(to) = transition_out {
        let dur = to.dur_ms.min(span);
        let start_out = end_ms.saturating_sub(dur);
        if dur > 0 && t_ms > start_out {
            let u = end_ms.saturating_sub(t_ms) as f32 / dur as f32;
            let f = ease(Easing::EaseInOut, u);
            if f < factor {
                factor = f;
                kind = Some(to.kind);
                direction = to.direction;
                engine = to.engine.clone();
                params = to.params.clone();
            }
        }
    }
    kind.map(|kind| ResolvedTransition { kind, factor: factor.clamp(0.0, 1.0), direction, engine, params })
}

/// One effect with its parameters resolved at a point in time (camelCase field
/// names map straight onto the frontend renderer).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum ResolvedEffect {
    Grayscale { amount: f32 },
    Brightness { amount: f32 },
    Contrast { amount: f32 },
    Saturate { amount: f32 },
    Blur { radius: f32 },
    Hue { degrees: f32 },
    Invert { amount: f32 },
    Wipe { angle: f32, position: f32, softness: f32, invert: bool },
    /// `time` is the comp playhead in seconds (drives the drift/morph on the GPU,
    /// so the animation is fully determined by the timeline → export-accurate).
    ShinyClouds {
        time: f32,
        intensity: f32,
        scale: f32,
        speed: f32,
        complexity: f32,
        contrast: f32,
        brightness: f32,
        opacity: f32,
        tint: Rgba,
        blend: u8,
    },
    /// A GPU-overlay effect resolved at `time` (comp seconds). `effect` picks the
    /// algorithm in gpuOverlay.frag; the float slots are its generic knobs.
    GpuOverlay {
        effect: u8,
        time: f32,
        intensity: f32,
        scale: f32,
        speed: f32,
        detail: f32,
        softness: f32,
        extra: f32,
        opacity: f32,
        tint: Rgba,
        tint2: Rgba,
        #[serde(rename = "posX")]
        pos_x: f32,
        #[serde(rename = "posY")]
        pos_y: f32,
        blend: u8,
    },
}

/// Resolve one effect's keyframed parameters at `t_ms`.
fn resolve_effect(effect: &Effect, t_ms: u32) -> ResolvedEffect {
    match effect {
        Effect::Grayscale { amount } => {
            ResolvedEffect::Grayscale { amount: sample_track(amount, t_ms) }
        }
        Effect::Brightness { amount } => {
            ResolvedEffect::Brightness { amount: sample_track(amount, t_ms) }
        }
        Effect::Contrast { amount } => {
            ResolvedEffect::Contrast { amount: sample_track(amount, t_ms) }
        }
        Effect::Saturate { amount } => {
            ResolvedEffect::Saturate { amount: sample_track(amount, t_ms) }
        }
        Effect::Blur { radius } => ResolvedEffect::Blur { radius: sample_track(radius, t_ms) },
        Effect::Hue { degrees } => ResolvedEffect::Hue { degrees: sample_track(degrees, t_ms) },
        Effect::Invert { amount } => {
            ResolvedEffect::Invert { amount: sample_track(amount, t_ms) }
        }
        Effect::Wipe { angle, position, softness, invert } => ResolvedEffect::Wipe {
            angle: *angle,
            position: sample_track(position, t_ms),
            softness: sample_track(softness, t_ms),
            invert: *invert,
        },
        Effect::ShinyClouds {
            intensity, scale, speed, complexity, contrast, brightness, opacity, tint, blend,
        } => ResolvedEffect::ShinyClouds {
            time: t_ms as f32 / 1000.0,
            intensity: sample_track(intensity, t_ms),
            scale: sample_track(scale, t_ms),
            speed: sample_track(speed, t_ms),
            complexity: sample_track(complexity, t_ms),
            contrast: sample_track(contrast, t_ms),
            brightness: sample_track(brightness, t_ms),
            opacity: sample_track(opacity, t_ms),
            tint: *tint,
            blend: *blend,
        },
        Effect::GpuOverlay {
            effect, intensity, scale, speed, detail, softness, extra, opacity, tint, tint2,
            pos_x, pos_y, blend,
        } => ResolvedEffect::GpuOverlay {
            effect: *effect,
            time: t_ms as f32 / 1000.0,
            intensity: sample_track(intensity, t_ms),
            scale: sample_track(scale, t_ms),
            speed: sample_track(speed, t_ms),
            detail: sample_track(detail, t_ms),
            softness: sample_track(softness, t_ms),
            extra: sample_track(extra, t_ms),
            opacity: sample_track(opacity, t_ms),
            tint: *tint,
            tint2: *tint2,
            pos_x: *pos_x,
            pos_y: *pos_y,
            blend: *blend,
        },
    }
}

/// One glyph's offset from its resting shaped position at a given time.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LetterTransform {
    pub dx: f32,
    pub dy: f32,
    pub scale: f32,
    pub opacity: f32,
    pub rotation: f32,
    /// Skew (shear) in degrees, and the axis the skew is measured along (degrees).
    #[serde(default)]
    pub skew: f32,
    #[serde(default)]
    pub skew_axis: f32,
    /// Extra letter-spacing added for this glyph (px, cumulative along the run).
    #[serde(default)]
    pub tracking: f32,
    /// Per-glyph Gaussian blur radius (px).
    #[serde(default)]
    pub blur: f32,
    /// Per-glyph fill override (from a colour animator); `None` = the layer fill.
    #[serde(default)]
    pub fill: Option<crate::model::Rgba>,
    /// Per-character 3D (only when the layer enables it): X/Y rotation (degrees)
    /// and Z position (px).
    #[serde(default)]
    pub rx: f32,
    #[serde(default)]
    pub ry: f32,
    #[serde(default)]
    pub dz: f32,
}

impl LetterTransform {
    pub const IDENTITY: LetterTransform = LetterTransform {
        dx: 0.0,
        dy: 0.0,
        scale: 1.0,
        opacity: 1.0,
        rotation: 0.0,
        skew: 0.0,
        skew_axis: 0.0,
        tracking: 0.0,
        blur: 0.0,
        fill: None,
        rx: 0.0,
        ry: 0.0,
        dz: 0.0,
    };
}

/// Map an eased parameter `u` in [0, 1].
fn ease(easing: Easing, u: f32) -> f32 {
    let u = u.clamp(0.0, 1.0);
    match easing {
        Easing::Linear => u,
        Easing::EaseIn => u * u,
        Easing::EaseOut => 1.0 - (1.0 - u) * (1.0 - u),
        // Smoothstep: 3u^2 - 2u^3
        Easing::EaseInOut => u * u * (3.0 - 2.0 * u),
        // Step: handled before this is called (value holds at the left key).
        Easing::Hold => 0.0,
    }
}

/// Sample one track at comp time `t_ms`.
///
/// Before the first key clamps to the first value; after the last key clamps to
/// the last value. Between two keys, the LEFT key's easing shapes the segment.
pub fn sample_track(track: &Track, t_ms: u32) -> f32 {
    let keys = &track.keys;
    if keys.is_empty() {
        return track.default;
    }
    if t_ms <= keys[0].time_ms {
        return keys[0].value;
    }
    let last = &keys[keys.len() - 1];
    if t_ms >= last.time_ms {
        return last.value;
    }

    // Find the segment [k0, k1] containing t. Keys are assumed time-sorted.
    let mut i = 0;
    while i + 1 < keys.len() && keys[i + 1].time_ms <= t_ms {
        i += 1;
    }
    let k0 = &keys[i];
    let k1 = &keys[i + 1];

    if matches!(k0.easing, Easing::Hold) {
        return k0.value;
    }

    let span = (k1.time_ms - k0.time_ms).max(1) as f32;
    let u = (t_ms - k0.time_ms) as f32 / span;
    let e = ease(k0.easing, u);
    k0.value + (k1.value - k0.value) * e
}

/// Sample a text layer's fill colour at `t_ms`. Empty `keys` → the static
/// `default` fill. Otherwise clamps outside the range and interpolates between
/// the two surrounding keys using the left key's easing (Hold snaps).
pub fn sample_color(keys: &[ColorKey], default: Rgba, t_ms: u32) -> Rgba {
    if keys.is_empty() {
        return default;
    }
    if t_ms <= keys[0].time_ms {
        return keys[0].color;
    }
    let last = &keys[keys.len() - 1];
    if t_ms >= last.time_ms {
        return last.color;
    }
    let mut i = 0;
    while i + 1 < keys.len() && keys[i + 1].time_ms <= t_ms {
        i += 1;
    }
    let k0 = &keys[i];
    let k1 = &keys[i + 1];
    if matches!(k0.easing, Easing::Hold) {
        return k0.color;
    }
    let span = (k1.time_ms - k0.time_ms).max(1) as f32;
    let u = (t_ms - k0.time_ms) as f32 / span;
    blend_rgba(k0.color, k1.color, ease(k0.easing, u))
}

/// Build a `ShapeState` for a layer at `t_ms` if it's a `Shape3D` (samples its
/// 3D rotation + 2D placement). Shared by `evaluate` and the drag/drop pick.
pub fn shape_state_for(layer: &crate::model::Layer, t_ms: u32) -> Option<ShapeState> {
    let LayerKind::Shape3D {
        shape,
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
    } = &layer.kind
    else {
        return None;
    };
    let tf = &layer.transform;
    Some(ShapeState {
        shape: *shape,
        hw: sample_track(width, t_ms).max(1.0) / 2.0,
        hh: sample_track(height, t_ms).max(1.0) / 2.0,
        hd: sample_track(depth, t_ms).max(0.0) / 2.0,
        radius: sample_track(radius, t_ms).max(1.0),
        coverage: sample_track(coverage, t_ms).clamp(1.0, 360.0),
        rx: sample_track(rotation_x, t_ms),
        ry: sample_track(rotation_y, t_ms),
        rz: sample_track(rotation_z, t_ms),
        perspective: sample_track(perspective, t_ms).clamp(0.0, 1.0),
        focal: sample_track(focal_length, t_ms).max(50.0),
        sx: sample_track(&tf.x, t_ms),
        sy: sample_track(&tf.y, t_ms),
        ssx: sample_track(&tf.scale_x, t_ms),
        ssy: sample_track(&tf.scale_y, t_ms),
        srot: sample_track(&tf.rotation, t_ms),
    })
}

/// Resolve every layer in the project at comp time `t_ms`. `letter_counts` maps
/// a text layer's id to its shaped glyph count (the caller gets that from the
/// shaping cache) so per-letter animation can be evaluated here too.
pub fn evaluate(
    project: &Project,
    t_ms: u32,
    letter_counts: &HashMap<u32, usize>,
    text_dims: &HashMap<u32, (f32, f32)>,
) -> Vec<ResolvedLayer> {
    resolve_layers(&project.layers, t_ms, letter_counts, text_dims)
}

/// Resolve one layer list (recurses into `Group` children). Shapes are resolved
/// per list so a `Shape3D` and the images pinned to it composite within the same
/// scope (root or a group's contents).
fn resolve_layers(
    layers: &[Layer],
    t_ms: u32,
    letter_counts: &HashMap<u32, usize>,
    text_dims: &HashMap<u32, (f32, f32)>,
) -> Vec<ResolvedLayer> {
    // Pass 1: resolve every Shape3D into a ShapeState so the images pinned to it
    // (which may appear before or after it in the list) can be projected.
    let mut shapes: HashMap<u32, ShapeState> = HashMap::new();
    for layer in layers {
        if let Some(st) = shape_state_for(layer, t_ms) {
            shapes.insert(layer.id, st);
        }
    }

    // Pass 2: build the resolved layers.
    layers
        .iter()
        .map(|layer| {
            let tf = &layer.transform;
            let opacity = sample_track(&tf.opacity, t_ms).clamp(0.0, 1.0);
            let visible =
                !layer.hidden && t_ms >= layer.start_ms && t_ms <= layer.end_ms && opacity > 0.0;

            // Text fill colour, sampled at this time (keyframeable).
            let text_color = match &layer.kind {
                LayerKind::Text { color, color_keys, .. } => {
                    Some(sample_color(color_keys, *color, t_ms))
                }
                _ => None,
            };

            let letters = match &layer.kind {
                LayerKind::Text {
                    anim,
                    size,
                    parts,
                    decompose,
                    animators,
                    per_char_3d,
                    per_char_rx,
                    per_char_ry,
                    per_char_spread,
                    ..
                } => {
                    let count = letter_counts.get(&layer.id).copied().unwrap_or(0);
                    // Base per-letter transforms from the preset (or identity).
                    let mut base = match anim {
                        Some(a) => eval_letters(a, count, *size, t_ms, layer.start_ms),
                        None if parts.is_empty() && animators.is_empty() => Vec::new(),
                        None => vec![LetterTransform::IDENTITY; count],
                    };
                    // Blend the manual decompose pose in by the animated amount:
                    // 0 = composed, 1 = fully decomposed (the `parts` pose).
                    let amount = sample_track(decompose, t_ms);
                    if amount != 0.0 {
                        for (i, lt) in base.iter_mut().enumerate() {
                            if let Some(p) = parts.get(i) {
                                lt.dx += sample_track(&p.dx, t_ms) * amount;
                                lt.dy += sample_track(&p.dy, t_ms) * amount;
                                lt.rotation += sample_track(&p.rotation, t_ms) * amount;
                                lt.scale *= 1.0 + (sample_track(&p.scale, t_ms) - 1.0) * amount;
                            }
                        }
                    }
                    // Per-letter manual colour (independent of the decompose amount).
                    if !parts.is_empty() {
                        let base_col =
                            text_color.unwrap_or(Rgba { r: 255, g: 255, b: 255, a: 255 });
                        for (i, lt) in base.iter_mut().enumerate() {
                            if let Some(p) = parts.get(i) {
                                if !p.color_keys.is_empty() {
                                    lt.fill = Some(sample_color(&p.color_keys, base_col, t_ms));
                                }
                            }
                        }
                    }
                    // After Effects-style animators, applied on top of the base.
                    if !animators.is_empty() {
                        if base.len() != count {
                            base = vec![LetterTransform::IDENTITY; count];
                        }
                        let base_color = text_color.unwrap_or(Rgba { r: 255, g: 255, b: 255, a: 255 });
                        apply_animators(&mut base, animators, count, t_ms, base_color, *per_char_3d);
                    }
                    // Base per-character 3D pose (each glyph about its own centre).
                    if *per_char_3d && (*per_char_rx != 0.0 || *per_char_ry != 0.0 || *per_char_spread != 0.0) {
                        if base.len() != count {
                            base = vec![LetterTransform::IDENTITY; count];
                        }
                        for (i, lt) in base.iter_mut().enumerate() {
                            lt.rx += *per_char_rx;
                            lt.ry += *per_char_ry + i as f32 * *per_char_spread;
                        }
                    }
                    base
                }
                _ => Vec::new(),
            };

            // Shape3D → its visible-face frame.
            let shape = match &layer.kind {
                LayerKind::Shape3D { .. } => shapes.get(&layer.id).map(surface::shape_frame),
                _ => None,
            };
            // A layer pinned to a shape (image or text) → its decal, with the
            // placement sampled at this time so it can animate across the surface.
            let decal = layer.attach.as_ref().and_then(|d| {
                let dims = match &layer.kind {
                    LayerKind::Image { width, height, .. } => Some((*width as f32, *height as f32)),
                    LayerKind::Text { .. } => text_dims.get(&layer.id).copied(),
                    _ => None,
                };
                match (shapes.get(&d.shape_id), dims) {
                    (Some(st), Some((w, h))) => Some(surface::decal_surface(
                        st,
                        d.face,
                        sample_track(&d.u, t_ms),
                        sample_track(&d.v, t_ms),
                        sample_track(&d.scale, t_ms),
                        sample_track(&d.rotation, t_ms),
                        w,
                        h,
                    )),
                    _ => None,
                }
            });

            let effects: Vec<ResolvedEffect> =
                layer.effects.iter().map(|e| resolve_effect(e, t_ms)).collect();

            // FrameGrid → its resolved (warped) lattice + per-cell quads.
            let frame_grid = match &layer.kind {
                LayerKind::FrameGrid {
                    rows,
                    cols,
                    cell_w,
                    cell_h,
                    vertices,
                    cells,
                    linked,
                    line_width,
                    line_color,
                    line_color_keys,
                    background,
                    ..
                } => Some(resolve_frame_grid(
                    *rows,
                    *cols,
                    *cell_w,
                    *cell_h,
                    vertices,
                    cells,
                    linked,
                    *line_width,
                    *line_color,
                    line_color_keys,
                    background,
                    layer.start_ms,
                    layer.end_ms,
                    t_ms,
                )),
                _ => None,
            };

            // Group → recursively resolve its children (nested precomp).
            let group = match &layer.kind {
                LayerKind::Group { children } => Some(ResolvedGroup {
                    children: resolve_layers(children, t_ms, letter_counts, text_dims),
                }),
                _ => None,
            };

            // Shape2D → its paint properties sampled at this time.
            let shape2d = match &layer.kind {
                LayerKind::Shape2D { style } => Some(resolve_shape2d(style, t_ms)),
                _ => None,
            };

            // A decal is baked into comp space, so its image-layer transform is
            // identity (only opacity still applies). Everything else uses its own
            // resolved transform.
            let attached = decal.is_some();
            ResolvedLayer {
                id: layer.id,
                visible,
                x: if attached { 0.0 } else { sample_track(&tf.x, t_ms) },
                y: if attached { 0.0 } else { sample_track(&tf.y, t_ms) },
                scale_x: if attached { 1.0 } else { sample_track(&tf.scale_x, t_ms) },
                scale_y: if attached { 1.0 } else { sample_track(&tf.scale_y, t_ms) },
                rotation: if attached { 0.0 } else { sample_track(&tf.rotation, t_ms) },
                opacity,
                color: text_color,
                letters,
                surface: decal,
                shape,
                effects,
                transition: resolve_transition(layer, t_ms),
                frame_grid,
                group,
                shape2d,
            }
        })
        .collect()
}

/// Compute every letter's offset for a preset at time `t_ms`.
pub fn eval_letters(
    anim: &LetterAnimation,
    count: usize,
    size: f32,
    t_ms: u32,
    layer_start_ms: u32,
) -> Vec<LetterTransform> {
    (0..count)
        .map(|i| letter_at(anim, i, size, t_ms, layer_start_ms))
        .collect()
}

fn letter_at(
    anim: &LetterAnimation,
    i: usize,
    size: f32,
    t_ms: u32,
    layer_start_ms: u32,
) -> LetterTransform {
    // The animation is anchored to the LAYER'S start, with `anim.start_ms` an
    // offset from there — so applying a preset animates over the layer's own
    // intro regardless of where the block sits on the timeline. (If it were
    // anchored to absolute comp time, a layer starting after the animation
    // window would show its letters already at rest — i.e. no visible effect.)
    let start =
        layer_start_ms as f32 + anim.start_ms as f32 + i as f32 * anim.stagger_ms as f32;
    let dur = anim.duration_ms.max(1) as f32;
    let local = ((t_ms as f32 - start) / dur).clamp(0.0, 1.0);
    let e = 1.0 - (1.0 - local) * (1.0 - local); // ease-out

    let mut lt = LetterTransform::IDENTITY;
    match anim.preset {
        LetterPreset::FadeIn => lt.opacity = e,
        LetterPreset::ScalePop => {
            lt.scale = ease_out_back(local);
            lt.opacity = (local * 2.0).clamp(0.0, 1.0);
        }
        LetterPreset::RiseUp => {
            lt.dy = (1.0 - e) * size * 0.6;
            lt.opacity = e;
        }
        LetterPreset::ScatterIn => {
            // Letters start exploded within a `area_px`-radius region and gather
            // to their resting place.
            let (rx, ry, rr) = scatter(i);
            lt.dx = (1.0 - e) * rx * anim.area_px;
            lt.dy = (1.0 - e) * ry * anim.area_px;
            lt.rotation = (1.0 - e) * rr;
            lt.opacity = (local * 1.5).clamp(0.0, 1.0);
        }
        LetterPreset::Typewriter => lt.opacity = if t_ms as f32 >= start { 1.0 } else { 0.0 },
    }
    lt
}

/// Overshoot ease for the pop preset.
fn ease_out_back(x: f32) -> f32 {
    let c1 = 1.70158;
    let c3 = c1 + 1.0;
    1.0 + c3 * (x - 1.0).powi(3) + c1 * (x - 1.0).powi(2)
}

// --- Text animators (After Effects-style) ---------------------------------

fn hashf(mut h: u32) -> f32 {
    h = h.wrapping_mul(747796405).wrapping_add(2891336453);
    h = ((h >> ((h >> 28).wrapping_add(4))) ^ h).wrapping_mul(277803737);
    (((h >> 22) ^ h) as f32) / (u32::MAX as f32)
}

/// Smooth value noise in [0,1] over a spatial coord `x` and time `t`.
fn noise01(x: f32, t: f32, seed: u32) -> f32 {
    let (xi, xf) = (x.floor(), x - x.floor());
    let (ti, tf) = (t.floor(), t - t.floor());
    let u = xf * xf * (3.0 - 2.0 * xf);
    let v = tf * tf * (3.0 - 2.0 * tf);
    let h = |a: f32, b: f32| {
        hashf(
            (a as i32 as u32)
                .wrapping_mul(374761393)
                ^ (b as i32 as u32).wrapping_mul(668265263)
                ^ seed.wrapping_mul(2246822519),
        )
    };
    let (a, b) = (h(xi, ti), h(xi + 1.0, ti));
    let (c, d) = (h(xi, ti + 1.0), h(xi + 1.0, ti + 1.0));
    a * (1.0 - u) * (1.0 - v) + b * u * (1.0 - v) + c * (1.0 - u) * v + d * u * v
}

fn blend_rgba(a: Rgba, b: Rgba, t: f32) -> Rgba {
    let t = t.clamp(0.0, 1.0);
    let m = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * t).round().clamp(0.0, 255.0) as u8;
    Rgba { r: m(a.r, b.r), g: m(a.g, b.g), b: m(a.b, b.b), a: m(a.a, b.a) }
}

/// Blend a linear selection toward smoothstep by the average of the ease knobs.
fn apply_ease(s: f32, ease_high: f32, ease_low: f32) -> f32 {
    let ease = ((ease_high + ease_low) / 200.0).clamp(0.0, 1.0);
    let smooth = s * s * (3.0 - 2.0 * s);
    (s * (1.0 - ease) + smooth * ease).clamp(0.0, 1.0)
}

/// The 0..1 selection amount a selector assigns to character `i` of `count` at
/// comp time `t_ms`. Every selector parameter is sampled from its `Track` at
/// `t_ms`, so keyframing e.g. the range `offset` sweeps the selection over time.
fn selector_amount(sel: &AnimSelector, i: usize, count: usize, t_ms: u32) -> f32 {
    let c = if count <= 1 { 0.5 } else { (i as f32 + 0.5) / count as f32 };
    match sel.kind {
        SelectorKind::Expression => 1.0,
        SelectorKind::Wiggly => {
            let t = t_ms as f32 / 1000.0;
            let cor = (sample_track(&sel.correlation, t_ms) / 100.0).clamp(0.0, 1.0);
            let sx = i as f32 * (1.0 - cor) * 1.3 + sample_track(&sel.spatial_phase, t_ms) / 57.2958;
            let tt = t * sample_track(&sel.wiggles_per_sec, t_ms) + sample_track(&sel.temporal_phase, t_ms) / 57.2958;
            (sample_track(&sel.amount, t_ms) / 100.0).clamp(0.0, 1.0) * noise01(sx, tt, sel.seed.max(1))
        }
        SelectorKind::Range => {
            let offset = sample_track(&sel.offset, t_ms);
            let a = (sample_track(&sel.start, t_ms) + offset) / 100.0;
            let b = (sample_track(&sel.end, t_ms) + offset) / 100.0;
            let (ws, we) = (a.min(b), a.max(b));
            let w = (we - ws).max(1e-4);
            let inside = c >= ws && c <= we;
            let mut s = match sel.shape {
                RangeShape::Square => {
                    if inside {
                        1.0
                    } else {
                        0.0
                    }
                }
                RangeShape::RampUp => ((c - ws) / w).clamp(0.0, 1.0),
                RangeShape::RampDown => ((we - c) / w).clamp(0.0, 1.0),
                RangeShape::Triangle => {
                    (1.0 - ((c - (ws + we) * 0.5) / (w * 0.5)).abs()).clamp(0.0, 1.0)
                }
                RangeShape::Round | RangeShape::Smooth => {
                    let x = ((c - ws) / w).clamp(0.0, 1.0);
                    x * x * (3.0 - 2.0 * x)
                }
            };
            // Feather the hard square edges by `smoothness`. The soft ramp sits
            // OUTSIDE the [ws, we] range (0 at ws-feather → 1 at ws, and 1 at we →
            // 0 at we+feather), so every item INSIDE the range stays fully
            // selected. (A centred straddle would eat `feather` into the range and
            // leave the first/last selected items only partly selected — which is
            // why a "hide then reveal" animator's end letters peeked through.)
            if matches!(sel.shape, RangeShape::Square) {
                let feather = (sample_track(&sel.smoothness, t_ms) / 100.0) * w * 0.5;
                if feather > 1e-4 {
                    let up = ((c - (ws - feather)) / feather).clamp(0.0, 1.0);
                    let down = (((we + feather) - c) / feather).clamp(0.0, 1.0);
                    s = up.min(down);
                }
            }
            apply_ease(s, sample_track(&sel.ease_high, t_ms), sample_track(&sel.ease_low, t_ms))
        }
    }
}

/// Apply every animator to the base per-letter transforms (each property scaled
/// by that character's selector amount, summed across animators).
fn apply_animators(base: &mut [LetterTransform], animators: &[TextAnimator], count: usize, t_ms: u32, color: Rgba, per_char_3d: bool) {
    if count == 0 {
        return;
    }
    for anim in animators {
        let p = &anim.props;
        // Sample each property track once at the playhead — they're constant
        // across characters (the selector amount is what varies per character).
        let pos_x = sample_track(&p.position[0], t_ms);
        let pos_y = sample_track(&p.position[1], t_ms);
        let rotation = sample_track(&p.rotation, t_ms);
        let skew = sample_track(&p.skew, t_ms);
        let skew_axis = sample_track(&p.skew_axis, t_ms);
        let scale = sample_track(&p.scale, t_ms);
        let opacity = sample_track(&p.opacity, t_ms);
        let tracking = sample_track(&p.tracking, t_ms);
        let blur = sample_track(&p.blur, t_ms);
        let rot_x = sample_track(&p.rotation_x, t_ms);
        let rot_y = sample_track(&p.rotation_y, t_ms);
        let pos_z = sample_track(&p.position_z, t_ms);
        for i in 0..count.min(base.len()) {
            let a = selector_amount(&anim.selector, i, count, t_ms);
            if a <= 0.0 {
                continue;
            }
            let lt = &mut base[i];
            lt.dx += pos_x * a;
            lt.dy += pos_y * a;
            lt.rotation += rotation * a;
            lt.skew += skew * a;
            if skew_axis != 0.0 {
                lt.skew_axis = skew_axis;
            }
            lt.scale *= 1.0 + (scale / 100.0 - 1.0) * a;
            lt.opacity *= 1.0 + (opacity / 100.0 - 1.0) * a;
            lt.tracking += tracking * a;
            lt.blur += blur * a;
            if let Some(fc) = p.fill {
                let from = lt.fill.unwrap_or(color);
                lt.fill = Some(blend_rgba(from, fc, a));
            }
            if per_char_3d {
                lt.rx += rot_x * a;
                lt.ry += rot_y * a;
                lt.dz += pos_z * a;
            }
        }
    }
    for lt in base.iter_mut() {
        lt.opacity = lt.opacity.clamp(0.0, 1.0);
    }
}

/// Deterministic per-letter scatter offsets (no RNG, so it's reproducible and
/// resume-safe): returns (dx, dy) normalized to roughly -1..1 and rotation
/// degrees. The caller scales dx/dy by the desired area radius.
fn scatter(i: usize) -> (f32, f32, f32) {
    let h = (i as u32).wrapping_mul(2654435761).wrapping_add(0x9e3779b9);
    let a = (h & 0xff) as f32 / 255.0;
    let b = ((h >> 8) & 0xff) as f32 / 255.0;
    let c = ((h >> 16) & 0xff) as f32 / 255.0;
    ((a - 0.5) * 2.0, (b - 0.5) * 2.0, (c - 0.5) * 180.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Easing, Keyframe};
    use std::collections::HashMap;

    fn ramp() -> Track {
        Track {
            default: 0.0,
            keys: vec![
                Keyframe { time_ms: 0, value: 0.0, easing: Easing::Linear },
                Keyframe { time_ms: 1000, value: 100.0, easing: Easing::Linear },
            ],
        }
    }

    #[test]
    fn clamps_before_and_after() {
        let t = ramp();
        assert_eq!(sample_track(&t, 0), 0.0);
        assert_eq!(sample_track(&t, 2000), 100.0);
    }

    #[test]
    fn linear_midpoint() {
        let t = ramp();
        assert_eq!(sample_track(&t, 500), 50.0);
    }

    #[test]
    fn empty_track_uses_default() {
        let t = Track::constant(7.0);
        assert_eq!(sample_track(&t, 1234), 7.0);
    }

    #[test]
    fn hold_steps() {
        let t = Track {
            default: 0.0,
            keys: vec![
                Keyframe { time_ms: 0, value: 10.0, easing: Easing::Hold },
                Keyframe { time_ms: 1000, value: 20.0, easing: Easing::Linear },
            ],
        };
        assert_eq!(sample_track(&t, 999), 10.0);
        assert_eq!(sample_track(&t, 1000), 20.0);
    }

    #[test]
    fn color_no_keys_uses_static() {
        let white = Rgba { r: 255, g: 255, b: 255, a: 255 };
        assert_eq!(sample_color(&[], white, 0).r, 255);
        assert_eq!(sample_color(&[], white, 5000).r, 255);
    }

    #[test]
    fn color_interpolates_between_keys() {
        let black = Rgba { r: 0, g: 0, b: 0, a: 255 };
        let white = Rgba { r: 255, g: 255, b: 255, a: 255 };
        let keys = vec![
            ColorKey { time_ms: 0, color: black, easing: Easing::Linear },
            ColorKey { time_ms: 1000, color: white, easing: Easing::Linear },
        ];
        // Endpoints hold; midpoint is halfway grey.
        assert_eq!(sample_color(&keys, black, 0).r, 0);
        assert_eq!(sample_color(&keys, black, 1000).r, 255);
        assert_eq!(sample_color(&keys, black, 2000).r, 255); // clamps after last
        let mid = sample_color(&keys, black, 500).r;
        assert!((120..=135).contains(&mid), "midpoint grey was {mid}");
    }

    #[test]
    fn color_hold_steps() {
        let a = Rgba { r: 10, g: 0, b: 0, a: 255 };
        let b = Rgba { r: 200, g: 0, b: 0, a: 255 };
        let keys = vec![
            ColorKey { time_ms: 0, color: a, easing: Easing::Hold },
            ColorKey { time_ms: 1000, color: b, easing: Easing::Linear },
        ];
        assert_eq!(sample_color(&keys, a, 999).r, 10);
        assert_eq!(sample_color(&keys, a, 1000).r, 200);
    }

    fn base_selector(kind: SelectorKind) -> AnimSelector {
        AnimSelector {
            kind,
            start: Track::constant(0.0),
            end: Track::constant(100.0),
            offset: Track::constant(0.0),
            smoothness: Track::constant(0.0),
            ease_high: Track::constant(0.0),
            ease_low: Track::constant(0.0),
            shape: RangeShape::RampUp,
            wiggles_per_sec: Track::constant(2.0),
            amount: Track::constant(100.0),
            correlation: Track::constant(50.0),
            temporal_phase: Track::constant(0.0),
            spatial_phase: Track::constant(0.0),
            seed: 1,
        }
    }

    fn zero_props() -> crate::model::AnimProps {
        crate::model::AnimProps {
            position: [Track::constant(0.0), Track::constant(0.0)],
            scale: Track::constant(100.0),
            rotation: Track::constant(0.0),
            skew: Track::constant(0.0),
            skew_axis: Track::constant(0.0),
            opacity: Track::constant(100.0),
            tracking: Track::constant(0.0),
            blur: Track::constant(0.0),
            fill: None,
            char_offset: 0,
            rotation_x: Track::constant(0.0),
            rotation_y: Track::constant(0.0),
            position_z: Track::constant(0.0),
        }
    }

    #[test]
    fn animator_position_offsets_letters() {
        // A static Range (Ramp Up) with a Y offset should displace letters now —
        // more toward the end of the run (ramp).
        let mut props = zero_props();
        props.position[1] = Track::constant(-50.0);
        let anim = TextAnimator { selector: base_selector(SelectorKind::Range), props };
        let mut base = vec![LetterTransform::IDENTITY; 6];
        apply_animators(&mut base, std::slice::from_ref(&anim), 6, 0, Rgba { r: 255, g: 255, b: 255, a: 255 }, false);
        // Last char (fully selected on a ramp) moves; magnitude grows along the run.
        assert!(base[5].dy < -1.0, "last letter should be offset: {}", base[5].dy);
        assert!(base[5].dy < base[1].dy, "ramp should offset later letters more");
    }

    #[test]
    fn keyframed_offset_sweeps_over_time() {
        // Keyframing the selector Offset makes a Range animator animate: the same
        // letter is selected differently at different times, so its offset changes.
        let mut sel = base_selector(SelectorKind::Range);
        sel.shape = RangeShape::RampUp;
        // Narrow window that slides across the run as offset goes -100 -> 0.
        sel.start = Track::constant(0.0);
        sel.end = Track::constant(30.0);
        sel.offset = Track {
            default: -100.0,
            keys: vec![
                Keyframe { time_ms: 0, value: -100.0, easing: Easing::Linear },
                Keyframe { time_ms: 1000, value: 100.0, easing: Easing::Linear },
            ],
        };
        let mut props = zero_props();
        props.position[1] = Track::constant(-40.0);
        let anim = TextAnimator { selector: sel, props };

        let sample = |t: u32| {
            let mut base = vec![LetterTransform::IDENTITY; 8];
            apply_animators(&mut base, std::slice::from_ref(&anim), 8, t, Rgba { r: 255, g: 255, b: 255, a: 255 }, false);
            base.iter().map(|l| l.dy).collect::<Vec<_>>()
        };
        let early = sample(0);
        let mid = sample(500);
        let late = sample(1000);
        // The set of displaced letters must change over time (it animates).
        assert_ne!(early, mid, "offset keyframe should change the selection over time");
        assert_ne!(mid, late, "offset keyframe should keep sweeping");
    }

    #[test]
    fn shape2d_bend_keyframes_animate() {
        use crate::model::{Layer, LayerKind, Shape2DStyle, Transform, VectorShape};
        let mut style = Shape2DStyle::new(VectorShape::Arrow, 300.0);
        style.bend = Track {
            default: 0.0,
            keys: vec![
                Keyframe { time_ms: 0, value: 0.0, easing: Easing::Linear },
                Keyframe { time_ms: 1000, value: 100.0, easing: Easing::Linear },
            ],
        };
        let layer = Layer {
            id: 1,
            name: "Arrow".into(),
            start_ms: 0,
            end_ms: 4000,
            kind: LayerKind::Shape2D { style },
            transform: Transform::at(100.0, 100.0),
            hidden: false,
            attach: None,
            effects: vec![],
            transition_in: None,
            transition_out: None,
        };
        let p = Project { width: 1920, height: 1080, fps: 30, duration_ms: 4000, layers: vec![layer], media: vec![] };
        let bend_at = |t: u32| evaluate(&p, t, &HashMap::new(), &HashMap::new())[0].shape2d.clone().unwrap().bend;
        assert_eq!(bend_at(0), 0.0);
        assert!((bend_at(500) - 50.0).abs() < 1.0, "midpoint should be ~50: {}", bend_at(500));
        assert_eq!(bend_at(1000), 100.0);
    }

    #[test]
    fn demo_evaluates() {
        let p = Project::demo();
        let r = evaluate(&p, 0, &HashMap::new(), &HashMap::new());
        assert_eq!(r.len(), 3);
        // Accent (id 2) starts fully transparent at t=0.
        let accent = r.iter().find(|l| l.id == 2).unwrap();
        assert_eq!(accent.opacity, 0.0);
        assert!(!accent.visible);
    }
}
