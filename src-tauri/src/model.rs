//! The single source of truth for a project.
//!
//! These types are derived with `ts-rs`, which exports matching TypeScript
//! definitions into `../src/bindings/` whenever `cargo test` runs. The frontend
//! imports those generated types, so the data model can never silently drift
//! between Rust (export) and TS (preview).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::text::Font;

/// A complete animation project. This is what gets serialised to `.ron` on save
/// and handed to the export pipeline.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Project {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration_ms: u32,
    /// Drawn back-to-front: index 0 is the bottom layer.
    pub layers: Vec<Layer>,
}

/// One item on the timeline.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Layer {
    pub id: u32,
    pub name: String,
    /// Time range during which the layer is visible (comp time, ms).
    pub start_ms: u32,
    pub end_ms: u32,
    pub kind: LayerKind,
    /// Animatable transform. Keyframe times are in comp time (absolute).
    pub transform: Transform,
    /// Manually toggled off in the layer list (independent of the time range).
    #[serde(default)]
    pub hidden: bool,
}

/// What a layer actually draws. Internally tagged so the TS side is a clean
/// discriminated union on `kind`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum LayerKind {
    /// An image loaded from an absolute path on disk. `width`/`height` are the
    /// image's natural pixel size; the layer is scaled (via its transform) to
    /// fit the comp when added.
    Image { src: String, width: u32, height: u32 },
    /// A text run. `anim` opt-in drives per-letter animation from a preset;
    /// `parts` holds manual per-glyph move/rotate/scale (decompose mode).
    Text {
        content: String,
        /// Font size in px (the letter "height").
        size: f32,
        color: Rgba,
        font: Font,
        anim: Option<LetterAnimation>,
        #[serde(default)]
        parts: Vec<LetterOverride>,
        /// Keyframeable 0..1: how much of `parts` is applied. 0 = composed,
        /// 1 = fully decomposed. Keyframe it to animate the decompose effect.
        #[serde(default)]
        decompose: Track,
    },
    /// A flat coloured rectangle, optionally composited with a blend mode.
    ColorPatch {
        color: Rgba,
        blend: BlendMode,
        width: f32,
        height: f32,
    },
}

/// Per-property keyframe tracks. `x`/`y` are the layer's CENTRE in comp pixels;
/// scaling and rotation happen about that centre.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Transform {
    pub x: Track,
    pub y: Track,
    pub scale_x: Track,
    pub scale_y: Track,
    /// Degrees, clockwise (matches Konva).
    pub rotation: Track,
    /// 0.0 .. 1.0
    pub opacity: Track,
}

/// A single animatable property: a list of keyframes plus the value to use when
/// the track is empty.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Track {
    pub keys: Vec<Keyframe>,
    pub default: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Keyframe {
    pub time_ms: u32,
    pub value: f32,
    /// Easing applied across the segment that STARTS at this keyframe.
    pub easing: Easing,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum Easing {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    /// Step: hold this keyframe's value until the next keyframe.
    Hold,
}

/// Per-letter animation for `Text` layers, driven by a named preset. Each glyph
/// runs the preset over `duration_ms`, offset from its neighbour by `stagger_ms`
/// — so the letters animate in sequence. The actual per-letter math lives in the
/// evaluator (single source of truth).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LetterAnimation {
    pub preset: LetterPreset,
    /// When the first letter starts (comp ms).
    pub start_ms: u32,
    /// How long a single letter takes to settle (ms).
    pub duration_ms: u32,
    /// Delay added per letter index (ms).
    pub stagger_ms: u32,
    /// For `ScatterIn`: how far letters explode out before gathering (px radius).
    pub area_px: f32,
}

/// The predefined per-letter effects the user can pick from.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum LetterPreset {
    /// Opacity 0 → 1.
    FadeIn,
    /// Scale up with a small overshoot.
    ScalePop,
    /// Slide up into place while fading in.
    RiseUp,
    /// Fly in from a scattered offset + rotation.
    ScatterIn,
    /// Appear one letter at a time (hard cut).
    Typewriter,
}

/// A manual per-glyph transform for "decompose" mode: move / rotate / scale one
/// letter by hand. Added on top of (independent of) any preset animation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LetterOverride {
    pub dx: f32,
    pub dy: f32,
    pub rotation: f32,
    pub scale: f32,
}

impl Default for LetterOverride {
    fn default() -> Self {
        Self { dx: 0.0, dy: 0.0, rotation: 0.0, scale: 1.0 }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum BlendMode {
    Normal,
    Multiply,
    Screen,
    Overlay,
}

/// A partial transform edit from the canvas. Only the properties the user
/// actually changed are `Some`; the rest are left untouched.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TransformEdit {
    #[ts(optional)]
    pub x: Option<f32>,
    #[ts(optional)]
    pub y: Option<f32>,
    #[ts(optional)]
    pub scale_x: Option<f32>,
    #[ts(optional)]
    pub scale_y: Option<f32>,
    #[ts(optional)]
    pub rotation: Option<f32>,
    #[ts(optional)]
    pub opacity: Option<f32>,
}

impl Track {
    /// A track with no keyframes that always reads `default`.
    pub fn constant(default: f32) -> Self {
        Track { keys: vec![], default }
    }

    /// A two-keyframe ramp from `a`@`a_ms` to `b`@`b_ms`.
    pub fn ramp(a: f32, a_ms: u32, b: f32, b_ms: u32, easing: Easing) -> Self {
        Track {
            default: a,
            keys: vec![
                Keyframe { time_ms: a_ms, value: a, easing },
                Keyframe { time_ms: b_ms, value: b, easing: Easing::Linear },
            ],
        }
    }
}

impl Transform {
    /// A static transform centred at `(x, y)` with no animation.
    pub fn at(x: f32, y: f32) -> Self {
        Transform {
            x: Track::constant(x),
            y: Track::constant(y),
            scale_x: Track::constant(1.0),
            scale_y: Track::constant(1.0),
            rotation: Track::constant(0.0),
            opacity: Track::constant(1.0),
        }
    }
}

impl Project {
    /// A small demo project so the very first run shows something animating:
    /// a dark backdrop, an accent square that scales + fades in (Ken Burns),
    /// and a title that slides up while fading in. No external assets required.
    pub fn demo() -> Self {
        let (w, h) = (1920u32, 1080u32);
        let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);

        let backdrop = Layer {
            id: 1,
            name: "Backdrop".into(),
            start_ms: 0,
            end_ms: 4000,
            kind: LayerKind::ColorPatch {
                color: Rgba { r: 26, g: 26, b: 46, a: 255 },
                blend: BlendMode::Normal,
                width: w as f32,
                height: h as f32,
            },
            transform: Transform::at(cx, cy),
            hidden: false,
        };

        let mut accent_tf = Transform::at(cx, cy - 40.0);
        accent_tf.scale_x = Track::ramp(1.3, 0, 1.0, 1800, Easing::EaseOut);
        accent_tf.scale_y = Track::ramp(1.3, 0, 1.0, 1800, Easing::EaseOut);
        accent_tf.opacity = Track::ramp(0.0, 0, 1.0, 600, Easing::EaseOut);
        let accent = Layer {
            id: 2,
            name: "Accent".into(),
            start_ms: 0,
            end_ms: 4000,
            kind: LayerKind::ColorPatch {
                color: Rgba { r: 233, g: 69, b: 96, a: 255 },
                blend: BlendMode::Normal,
                width: 560.0,
                height: 560.0,
            },
            transform: accent_tf,
            hidden: false,
        };

        let title = Layer {
            id: 3,
            name: "Title".into(),
            start_ms: 0,
            end_ms: 4000,
            kind: LayerKind::Text {
                content: "آموزش اتوکد پی‌دی‌اف رایگان".into(),
                size: 92.0,
                color: Rgba { r: 240, g: 240, b: 245, a: 255 },
                font: Font::Vazirmatn,
                anim: Some(LetterAnimation {
                    preset: LetterPreset::RiseUp,
                    start_ms: 300,
                    duration_ms: 700,
                    stagger_ms: 70,
                    area_px: 500.0,
                }),
                parts: vec![],
                decompose: Track::constant(0.0),
            },
            transform: Transform::at(cx, cy + 70.0),
            hidden: false,
        };

        Project {
            width: w,
            height: h,
            fps: 30,
            duration_ms: 4000,
            layers: vec![backdrop, accent, title],
        }
    }
}
