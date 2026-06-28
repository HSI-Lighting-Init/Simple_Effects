//! The authoritative animation evaluator.
//!
//! The preview (Konva) and the export pipeline (tiny-skia) BOTH call this code,
//! so what you see is what you render. The frontend asks for resolved transforms
//! over IPC (`evaluate_at`) rather than re-implementing easing in TypeScript —
//! one copy of the math, no preview/export drift.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{Easing, LayerKind, LetterAnimation, LetterPreset, Project, Track};

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
}

impl LetterTransform {
    pub const IDENTITY: LetterTransform =
        LetterTransform { dx: 0.0, dy: 0.0, scale: 1.0, opacity: 1.0, rotation: 0.0 };
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

/// Resolve every layer in the project at comp time `t_ms`. `letter_counts` maps
/// a text layer's id to its shaped glyph count (the caller gets that from the
/// shaping cache) so per-letter animation can be evaluated here too.
pub fn evaluate(
    project: &Project,
    t_ms: u32,
    letter_counts: &HashMap<u32, usize>,
) -> Vec<ResolvedLayer> {
    project
        .layers
        .iter()
        .map(|layer| {
            let tf = &layer.transform;
            let opacity = sample_track(&tf.opacity, t_ms).clamp(0.0, 1.0);
            let visible =
                !layer.hidden && t_ms >= layer.start_ms && t_ms <= layer.end_ms && opacity > 0.0;

            let letters = match &layer.kind {
                LayerKind::Text { anim, size, parts, .. } => {
                    let count = letter_counts.get(&layer.id).copied().unwrap_or(0);
                    // Base per-letter transforms from the preset (or identity).
                    let mut base = match anim {
                        Some(a) => eval_letters(a, count, *size, t_ms),
                        None if parts.is_empty() => Vec::new(),
                        None => vec![LetterTransform::IDENTITY; count],
                    };
                    // Add the manual per-glyph overrides (decompose mode) on top.
                    for (i, lt) in base.iter_mut().enumerate() {
                        if let Some(p) = parts.get(i) {
                            lt.dx += p.dx;
                            lt.dy += p.dy;
                            lt.rotation += p.rotation;
                            lt.scale *= p.scale;
                        }
                    }
                    base
                }
                _ => Vec::new(),
            };

            ResolvedLayer {
                id: layer.id,
                visible,
                x: sample_track(&tf.x, t_ms),
                y: sample_track(&tf.y, t_ms),
                scale_x: sample_track(&tf.scale_x, t_ms),
                scale_y: sample_track(&tf.scale_y, t_ms),
                rotation: sample_track(&tf.rotation, t_ms),
                opacity,
                letters,
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

    let mut lt = LetterTransform { dx: 0.0, dy: 0.0, scale: 1.0, opacity: 1.0, rotation: 0.0 };
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
        let r = evaluate(&p, 0, &HashMap::new());
        assert_eq!(r.len(), 3);
        // Accent (id 2) starts fully transparent at t=0.
        let accent = r.iter().find(|l| l.id == 2).unwrap();
        assert_eq!(accent.opacity, 0.0);
        assert!(!accent.visible);
    }
}
