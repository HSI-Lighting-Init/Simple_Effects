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
    AnimSelector, Easing, Effect, LayerKind, LetterAnimation, LetterPreset, Project, RangeShape,
    Rgba, SelectorKind, TextAnimator, Track, TransitionKind,
};
use crate::surface::{self, ResolvedShapeFrame, ResolvedSurface, ShapeState};

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

/// Resolve a layer's active transition (in or out) at `t_ms`, if any. When both
/// windows overlap, the more-transitioned (smaller factor) one wins.
fn resolve_transition(layer: &crate::model::Layer, t_ms: u32) -> Option<ResolvedTransition> {
    let mut factor = 2.0f32; // sentinel above any real factor
    let mut kind = None;
    let mut direction = 0u8;
    let mut engine: Option<String> = None;
    let mut params: Option<String> = None;
    if let Some(ti) = &layer.transition_in {
        if ti.dur_ms > 0 && t_ms < layer.start_ms + ti.dur_ms {
            let u = t_ms.saturating_sub(layer.start_ms) as f32 / ti.dur_ms as f32;
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
    if let Some(to) = &layer.transition_out {
        let start_out = layer.end_ms.saturating_sub(to.dur_ms);
        if to.dur_ms > 0 && t_ms > start_out {
            let u = layer.end_ms.saturating_sub(t_ms) as f32 / to.dur_ms as f32;
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
        hw: width / 2.0,
        hh: height / 2.0,
        hd: depth / 2.0,
        radius: *radius,
        coverage: *coverage,
        rx: sample_track(rotation_x, t_ms),
        ry: sample_track(rotation_y, t_ms),
        rz: sample_track(rotation_z, t_ms),
        perspective: *perspective,
        focal: *focal_length,
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
    // Pass 1: resolve every Shape3D into a ShapeState so the images pinned to it
    // (which may appear before or after it in the list) can be projected.
    let mut shapes: HashMap<u32, ShapeState> = HashMap::new();
    for layer in &project.layers {
        if let Some(st) = shape_state_for(layer, t_ms) {
            shapes.insert(layer.id, st);
        }
    }

    // Pass 2: build the resolved layers.
    project
        .layers
        .iter()
        .map(|layer| {
            let tf = &layer.transform;
            let opacity = sample_track(&tf.opacity, t_ms).clamp(0.0, 1.0);
            let visible =
                !layer.hidden && t_ms >= layer.start_ms && t_ms <= layer.end_ms && opacity > 0.0;

            let letters = match &layer.kind {
                LayerKind::Text {
                    anim,
                    size,
                    parts,
                    decompose,
                    animators,
                    color,
                    per_char_3d,
                    per_char_rx,
                    per_char_ry,
                    per_char_spread,
                    ..
                } => {
                    let count = letter_counts.get(&layer.id).copied().unwrap_or(0);
                    // Base per-letter transforms from the preset (or identity).
                    let mut base = match anim {
                        Some(a) => eval_letters(a, count, *size, t_ms),
                        None if parts.is_empty() && animators.is_empty() => Vec::new(),
                        None => vec![LetterTransform::IDENTITY; count],
                    };
                    // Blend the manual decompose pose in by the animated amount:
                    // 0 = composed, 1 = fully decomposed (the `parts` pose).
                    let amount = sample_track(decompose, t_ms);
                    if amount != 0.0 {
                        for (i, lt) in base.iter_mut().enumerate() {
                            if let Some(p) = parts.get(i) {
                                lt.dx += p.dx * amount;
                                lt.dy += p.dy * amount;
                                lt.rotation += p.rotation * amount;
                                lt.scale *= 1.0 + (p.scale - 1.0) * amount;
                            }
                        }
                    }
                    // After Effects-style animators, applied on top of the base.
                    if !animators.is_empty() {
                        if base.len() != count {
                            base = vec![LetterTransform::IDENTITY; count];
                        }
                        apply_animators(&mut base, animators, count, t_ms, *color, *per_char_3d);
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
                letters,
                surface: decal,
                shape,
                effects,
                transition: resolve_transition(layer, t_ms),
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
) -> Vec<LetterTransform> {
    (0..count).map(|i| letter_at(anim, i, size, t_ms)).collect()
}

fn letter_at(anim: &LetterAnimation, i: usize, size: f32, t_ms: u32) -> LetterTransform {
    let start = anim.start_ms as f32 + i as f32 * anim.stagger_ms as f32;
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

/// The 0..1 selection amount a selector assigns to character `i` of `count` at time `t` (seconds).
fn selector_amount(sel: &AnimSelector, i: usize, count: usize, t: f32) -> f32 {
    let c = if count <= 1 { 0.5 } else { (i as f32 + 0.5) / count as f32 };
    match sel.kind {
        SelectorKind::Expression => 1.0,
        SelectorKind::Wiggly => {
            let cor = (sel.correlation / 100.0).clamp(0.0, 1.0);
            let sx = i as f32 * (1.0 - cor) * 1.3 + sel.spatial_phase / 57.2958;
            let tt = t * sel.wiggles_per_sec + sel.temporal_phase / 57.2958;
            (sel.amount / 100.0).clamp(0.0, 1.0) * noise01(sx, tt, sel.seed.max(1))
        }
        SelectorKind::Range => {
            let a = (sel.start + sel.offset) / 100.0;
            let b = (sel.end + sel.offset) / 100.0;
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
            // Feather the hard square edges by `smoothness`.
            if matches!(sel.shape, RangeShape::Square) {
                let feather = (sel.smoothness / 100.0) * w * 0.5;
                if feather > 1e-4 {
                    let up = ((c - (ws - feather)) / (2.0 * feather)).clamp(0.0, 1.0);
                    let down = (((we + feather) - c) / (2.0 * feather)).clamp(0.0, 1.0);
                    s = up.min(down);
                }
            }
            apply_ease(s, sel.ease_high, sel.ease_low)
        }
    }
}

/// Apply every animator to the base per-letter transforms (each property scaled
/// by that character's selector amount, summed across animators).
fn apply_animators(base: &mut [LetterTransform], animators: &[TextAnimator], count: usize, t_ms: u32, color: Rgba, per_char_3d: bool) {
    if count == 0 {
        return;
    }
    let t = t_ms as f32 / 1000.0;
    for anim in animators {
        let p = &anim.props;
        for i in 0..count.min(base.len()) {
            let a = selector_amount(&anim.selector, i, count, t);
            if a <= 0.0 {
                continue;
            }
            let lt = &mut base[i];
            lt.dx += p.position[0] * a;
            lt.dy += p.position[1] * a;
            lt.rotation += p.rotation * a;
            lt.skew += p.skew * a;
            if p.skew_axis != 0.0 {
                lt.skew_axis = p.skew_axis;
            }
            lt.scale *= 1.0 + (p.scale / 100.0 - 1.0) * a;
            lt.opacity *= 1.0 + (p.opacity / 100.0 - 1.0) * a;
            lt.tracking += p.tracking * a;
            lt.blur += p.blur * a;
            if let Some(fc) = p.fill {
                let from = lt.fill.unwrap_or(color);
                lt.fill = Some(blend_rgba(from, fc, a));
            }
            if per_char_3d {
                lt.rx += p.rotation_x * a;
                lt.ry += p.rotation_y * a;
                lt.dz += p.position_z * a;
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
