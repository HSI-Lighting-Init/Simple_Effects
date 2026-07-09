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
    /// The media bin: imported image/video/audio file paths staged for this
    /// project (not necessarily placed on the timeline). Saved with the project
    /// so reopening a file restores its bin; a new project starts empty.
    #[serde(default)]
    pub media: Vec<String>,
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
    /// When set, this layer is pinned to a `Shape3D` and renders as a decal on
    /// its surface instead of flat. Honoured for image and text layers.
    #[serde(default)]
    pub attach: Option<Decal>,
    /// A stack of visual effects applied in order when the layer renders
    /// (currently honoured for flat image layers). Keyframeable.
    #[serde(default)]
    pub effects: Vec<Effect>,
    /// Optional transition played over the layer's first `dur_ms` (blends it in
    /// against whatever is below it).
    #[serde(default)]
    pub transition_in: Option<Transition>,
    /// Optional transition played over the layer's last `dur_ms` (blends it out).
    #[serde(default)]
    pub transition_out: Option<Transition>,
}

/// A per-layer in/out transition. Because layers composite back-to-front, a top
/// layer transitioning in over an overlap with the layer beneath reads as a
/// cross-transition. `direction` (0=left,1=right,2=up,3=down) is used by Slide
/// and Wipe; ignored by Dissolve.
///
/// `engine` optionally names a transition from the frontend transition engine
/// (e.g. "cube", "shatter", "glitch"); when set, the frontend renders that
/// instead of the built-in `kind`. `kind` stays as a legacy fallback so older
/// projects keep working.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Transition {
    pub kind: TransitionKind,
    pub dur_ms: u32,
    pub direction: u8,
    #[serde(default)]
    pub engine: Option<String>,
    /// Engine transition variables as a JSON object string (e.g.
    /// `{"amplitude":40,"seed":3}`). Opaque to Rust — the frontend owns the
    /// schema and passes these to the math engine at render time.
    #[serde(default)]
    pub params: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum TransitionKind {
    /// Cross-fade (animate opacity).
    Dissolve,
    /// Slide in/out from an edge (animate position offset).
    Slide,
    /// Directional hard reveal (clip).
    Wipe,
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
    /// An invisible 3D box or cylinder you can spin (the rotation tracks) and
    /// move/scale on the canvas (the layer transform). It draws nothing itself —
    /// `Image` layers pinned to it (via `Decal`) render on its surface. The
    /// `width`/`height`/`depth` set the box dimensions / cylinder size in comp px.
    Shape3D {
        shape: SurfaceShape,
        /// Box/cylinder dimensions (px). Keyframeable — animate the size over the
        /// clip. Bare numbers in older projects deserialize as constant tracks.
        #[serde(default, deserialize_with = "de_track")]
        width: Track,
        #[serde(default, deserialize_with = "de_track")]
        height: Track,
        /// Box depth (px). Ignored for cylinders. Keyframeable.
        #[serde(default, deserialize_with = "de_track")]
        depth: Track,
        rotation_x: Track,
        rotation_y: Track,
        rotation_z: Track,
        /// 0 = orthographic, 1 = full perspective foreshortening. Keyframeable.
        #[serde(default, deserialize_with = "de_track")]
        perspective: Track,
        /// Camera distance (px-ish). Larger = flatter perspective. Keyframeable.
        #[serde(default, deserialize_with = "de_track")]
        focal_length: Track,
        /// Cylinder: degrees of circumference shown (0..360). Ignored for boxes.
        /// Keyframeable.
        #[serde(default, deserialize_with = "de_track")]
        coverage: Track,
        /// Cylinder: radius (px). Ignored for boxes. Keyframeable.
        #[serde(default, deserialize_with = "de_track")]
        radius: Track,
    },
    /// A text run. `anim` opt-in drives per-letter animation from a preset;
    /// `parts` holds manual per-glyph move/rotate/scale (decompose mode).
    Text {
        content: String,
        /// Font size in px (the letter "height").
        size: f32,
        color: Rgba,
        /// Keyframeable fill colour. When non-empty this overrides `color` and is
        /// interpolated at the current time, so the text colour animates over the
        /// clip. Empty = the static `color` fill (back-compatible).
        #[serde(default, rename = "colorKeys")]
        color_keys: Vec<ColorKey>,
        font: Font,
        /// Font weight (100..900, CSS scale; 400 = Regular, 700 = Bold). Used to
        /// pick the matching face from the family when shaping.
        #[serde(default = "default_weight")]
        weight: u16,
        /// Select the italic/oblique face of the family when available.
        #[serde(default)]
        italic: bool,
        anim: Option<LetterAnimation>,
        #[serde(default)]
        parts: Vec<LetterOverride>,
        /// Keyframeable 0..1: how much of `parts` is applied. 0 = composed,
        /// 1 = fully decomposed. Keyframe it to animate the decompose effect.
        #[serde(default)]
        decompose: Track,
        /// Optional typographic + fill/stroke style (After Effects-style). `None`
        /// = the plain single-colour fill from `color` (back-compatible).
        #[serde(default)]
        style: Option<TextStyle>,
        /// After Effects-style per-character animators (Range/Wiggly selectors
        /// driving position/scale/rotation/opacity/tracking/skew/blur/colour).
        #[serde(default)]
        animators: Vec<TextAnimator>,
        /// Whole-layer non-destructive layer styles (shadow/glow/bevel/gradient).
        #[serde(default, rename = "layerStyles")]
        layer_styles: Option<TextLayerStyles>,
        /// Enable per-character 3D (animator rotationX/Y + positionZ apply, and
        /// the base per-character rotation below).
        #[serde(default, rename = "perChar3d")]
        per_char_3d: bool,
        /// Base per-character 3D rotation applied to EVERY glyph about its own
        /// centre (degrees). `per_char_spread` adds `index * spread` to the Y
        /// rotation so the characters fan out in a 3D wave.
        #[serde(default, rename = "perCharRx")]
        per_char_rx: f32,
        #[serde(default, rename = "perCharRy")]
        per_char_ry: f32,
        #[serde(default, rename = "perCharSpread")]
        per_char_spread: f32,
    },
    /// A flat coloured rectangle, optionally composited with a blend mode.
    ColorPatch {
        color: Rgba,
        blend: BlendMode,
        width: f32,
        height: f32,
    },
    /// A multi-frame grid: a warpable lattice of `rows`×`cols` image cells. It's a
    /// single timeline layer (the container); each cell is a lightweight child
    /// carrying its own source image + effect stack. The `vertices` lattice
    /// ((rows+1)×(cols+1), row-major) stores a keyframeable offset from each
    /// vertex's regular position, so the mesh can be warped (free-form) or moved
    /// along gridlines (rails) and animated. Draws in the layer's own transform.
    FrameGrid {
        rows: u32,
        cols: u32,
        /// Un-warped cell size in layer-local px. Grid is centred on the origin.
        cell_w: f32,
        cell_h: f32,
        /// Per-vertex warp offset (row-major, (rows+1)*(cols+1)). Empty = regular.
        #[serde(default)]
        vertices: Vec<GridVertex>,
        #[serde(default)]
        constrain: ConstrainMode,
        /// One per cell (row-major, rows*cols).
        cells: Vec<FrameCell>,
        /// Shared effect stacks applied across several cells at once (the "sync"
        /// feature). A member cell renders its local effects then each linked
        /// group it belongs to.
        #[serde(default)]
        linked: Vec<LinkedEffectGroup>,
        /// Grid line thickness in layer-local px (0 = no lines drawn). Scaled by
        /// the layer transform like the rest of the mesh.
        #[serde(default = "default_line_width")]
        line_width: f32,
        /// Base grid line colour. Overridden by `line_color_keys` when non-empty
        /// (so the line colour can be keyframed over the clip).
        #[serde(default = "default_line_color")]
        line_color: Rgba,
        /// Keyframeable grid line colour. Empty = the static `line_color`.
        #[serde(default, rename = "lineColorKeys")]
        line_color_keys: Vec<ColorKey>,
        /// Optional shared BACKGROUND image spanning the whole grid. When set,
        /// every cell reveals its aligned slice of this one image (a mask over a
        /// single photo) instead of its own `src`, and each cell's effect stack
        /// applies to that slice. `None` = per-cell images (the classic mode).
        #[serde(default)]
        background: Option<String>,
    },
    /// A video loaded from disk. Renders like an `Image` but the displayed frame
    /// tracks the playhead (comp time since the layer start → source time). The
    /// frontend owns decode/playback via an `HTMLVideoElement`; `width`/`height`
    /// are the natural pixel size and `duration_ms` the clip's intrinsic length.
    Video {
        src: String,
        width: u32,
        height: u32,
        #[serde(default, rename = "durationMs")]
        duration_ms: u32,
    },
    /// An audio clip. No visual — it plays during preview playback, synced to the
    /// playhead over its `[start_ms, end_ms]` range. `duration_ms` is the clip's
    /// intrinsic length.
    Audio {
        src: String,
        #[serde(default, rename = "durationMs")]
        duration_ms: u32,
    },
    /// A nested composition ("precomp"): a set of child layers composited as one
    /// unit under this layer's own transform / opacity / effects / transition.
    /// Children share the comp's time base. You "enter" the group to edit its
    /// children on their own timeline, and can "explode" it to lift them back out.
    Group { children: Vec<Layer> },
    /// An adjustment layer: it has no visual content of its own — instead its
    /// effect stack (`layer.effects`) is applied to the whole comp beneath it,
    /// over the layer's time span. Currently drives the GPU "shiny clouds"
    /// overlay; the frontend composites it over the layers below.
    Adjustment {},
    /// A 2D vector shape (rectangle, circle, or regular polygon) with a fill, a
    /// border, an outer glow and a drop shadow — each colour keyframeable and the
    /// numeric knobs on keyframe tracks. `style` carries the shape type, its base
    /// size, and all paint properties (the layer transform scales/rotates it).
    Shape2D { style: Shape2DStyle },
}

fn default_weight() -> u16 {
    400
}

fn default_line_width() -> f32 {
    0.0
}
fn default_line_color() -> Rgba {
    Rgba { r: 255, g: 255, b: 255, a: 255 }
}

/// A shared effect stack applied to several `FrameGrid` cells at once. Editing it
/// updates every member; "unlinking" a cell copies these effects into that cell's
/// own stack so it can diverge.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LinkedEffectGroup {
    pub id: u32,
    pub effects: Vec<Effect>,
    /// Cell indices (row-major) this group applies to.
    pub members: Vec<u32>,
}

/// One vertex of a `FrameGrid`'s lattice — a keyframeable offset (px) from the
/// vertex's regular grid position, so warps can animate over time.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct GridVertex {
    pub dx: Track,
    pub dy: Track,
}

/// How dragging a `FrameGrid` vertex behaves.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum ConstrainMode {
    /// Each vertex moves independently (arbitrary mesh warp).
    #[default]
    FreeForm,
    /// Dragging a vertex moves its whole row-line + column-line (cells stay
    /// aligned rectangles).
    Rails,
}

/// How a cell's image is fitted into its (possibly warped) cell.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum FitMode {
    /// Fill the cell, cropping overflow (aspect preserved).
    #[default]
    Cover,
    /// Fit inside the cell, letterboxing (aspect preserved).
    Contain,
    /// Stretch to the cell (aspect not preserved).
    Stretch,
}

/// One image cell of a `FrameGrid` (a lightweight child, not a timeline layer).
/// `src` is an absolute image path (`None` = an empty cell). `effects` is the
/// cell's own effect stack, applied when it renders.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct FrameCell {
    #[serde(default)]
    pub src: Option<String>,
    #[serde(default)]
    pub img_w: u32,
    #[serde(default)]
    pub img_h: u32,
    #[serde(default)]
    pub fit: FitMode,
    /// Keyframeable zoom of the image within its cell (1 = fit per `fit`, >1 =
    /// zoomed in / cropped, <1 = zoomed out). Scales about the cell centre.
    #[serde(default = "one_track")]
    pub zoom: Track,
    /// Keyframeable pan of the image within its cell, in fractions of the cell
    /// (0 = centred; ±0.5 shifts by half a cell). Lets you reposition the image
    /// inside its window — most useful together with `zoom`.
    #[serde(default)]
    pub pan_x: Track,
    #[serde(default)]
    pub pan_y: Track,
    /// Merge spans: how many columns/rows this cell covers (1 = a single slot).
    /// A cell with span > 1 is the "master" of a merged block; the slots it
    /// covers render nothing (their images are cleared on merge).
    #[serde(default = "one_u32")]
    pub col_span: u32,
    #[serde(default = "one_u32")]
    pub row_span: u32,
    #[serde(default)]
    pub effects: Vec<Effect>,
    /// Per-cell in/out transitions, played over the grid layer's start/end (the
    /// cell's image assembles in / breaks out). Same engine as layer transitions.
    #[serde(default)]
    pub transition_in: Option<Transition>,
    #[serde(default)]
    pub transition_out: Option<Transition>,
}

fn one_track() -> Track {
    Track::constant(1.0)
}
fn one_u32() -> u32 {
    1
}

impl Default for FrameCell {
    fn default() -> Self {
        FrameCell {
            src: None,
            img_w: 0,
            img_h: 0,
            fit: FitMode::default(),
            zoom: one_track(),
            pan_x: Track::default(),
            pan_y: Track::default(),
            col_span: 1,
            row_span: 1,
            effects: Vec::new(),
            transition_in: None,
            transition_out: None,
        }
    }
}

/// Resolve a grid's merge layout: for each slot (row-major) return whether it's
/// `covered` by another cell's span, and each master's effective `(row_span,
/// col_span)` (clamped to the grid and to not overlap an already-claimed slot).
/// Shared by the evaluator (rendering) and the merge command (validation).
pub fn grid_layout(rows: u32, cols: u32, cells: &[FrameCell]) -> (Vec<bool>, Vec<(u32, u32)>) {
    let n = (rows * cols) as usize;
    let mut covered = vec![false; n];
    let mut spans = vec![(1u32, 1u32); n];
    for r in 0..rows {
        for c in 0..cols {
            let idx = (r * cols + c) as usize;
            if covered[idx] {
                continue;
            }
            let mut cs = cells.get(idx).map(|x| x.col_span.max(1)).unwrap_or(1).min(cols - c);
            let mut rs = cells.get(idx).map(|x| x.row_span.max(1)).unwrap_or(1).min(rows - r);
            // Shrink the block if it would overlap an already-claimed slot.
            loop {
                let mut clash = false;
                for rr in r..r + rs {
                    for cc in c..c + cs {
                        if (rr, cc) != (r, c) && covered[(rr * cols + cc) as usize] {
                            clash = true;
                        }
                    }
                }
                if !clash {
                    break;
                }
                if cs > 1 {
                    cs -= 1;
                } else if rs > 1 {
                    rs -= 1;
                } else {
                    break;
                }
            }
            spans[idx] = (rs, cs);
            for rr in r..r + rs {
                for cc in c..c + cs {
                    if (rr, cc) != (r, c) {
                        covered[(rr * cols + cc) as usize] = true;
                    }
                }
            }
        }
    }
    (covered, spans)
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

/// A keyframe on a text layer's fill colour. `easing` shapes the segment that
/// STARTS at this key (mirrors `Keyframe` for scalar tracks). A colour can't ride
/// a scalar `Track` (it's four channels), so text colour gets its own key list.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ColorKey {
    pub time_ms: u32,
    pub color: Rgba,
    pub easing: Easing,
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
///
/// Each channel is its own keyframe track, so an individual letter can be
/// animated over time — drag it at one playhead position, drag it at another,
/// and it tweens between — exactly like the whole layer's transform keyframes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LetterOverride {
    pub dx: Track,
    pub dy: Track,
    pub rotation: Track,
    pub scale: Track,
    /// Keyframeable per-letter fill colour. Empty = the letter uses the layer's
    /// colour; non-empty overrides it (and animates, like the layer colour).
    #[serde(default, rename = "colorKeys")]
    pub color_keys: Vec<ColorKey>,
}

impl Default for LetterOverride {
    fn default() -> Self {
        Self {
            dx: Track::constant(0.0),
            dy: Track::constant(0.0),
            rotation: Track::constant(0.0),
            scale: Track::constant(1.0),
            color_keys: Vec::new(),
        }
    }
}

/// Where a text stroke sits relative to the glyph outline.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum StrokePosition {
    Inside,
    Center,
    Outside,
}

/// One fill layer in a text style (stacked bottom→top).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TextFill {
    pub color: Rgba,
    /// Fill opacity, 0..100 (percent).
    pub opacity: f32,
}

/// One stroke layer in a text style (stacked bottom→top).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TextStroke {
    pub color: Rgba,
    /// Stroke opacity, 0..100 (percent).
    pub opacity: f32,
    /// Stroke width in px.
    pub width: f32,
    pub position: StrokePosition,
}

/// After Effects-style typographic + paint style for a text layer. All fields
/// default to "no change", so an empty style renders like the plain `color` fill.
///
/// Wired to the renderer today: `fills`, `strokes`, `fill_over_stroke`,
/// `tracking`, `baseline_shift`. Persisted but not yet applied (need font /
/// multi-line infrastructure — a later stage): `font_family`, `fallback_stack`,
/// `font_style`, `variable_axes`, `leading`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TextStyle {
    #[serde(default)]
    pub fills: Vec<TextFill>,
    #[serde(default)]
    pub strokes: Vec<TextStroke>,
    /// true = fill drawn over stroke; false (default) = stroke over fill.
    #[serde(default)]
    pub fill_over_stroke: bool,
    /// Letter-spacing added between glyphs, px (negative = tighter).
    #[serde(default)]
    pub tracking: f32,
    /// Line spacing, px. 0 = auto (single-line today). Reserved for multi-line.
    #[serde(default)]
    pub leading: f32,
    /// Baseline offset for the whole block, px (positive = up).
    #[serde(default)]
    pub baseline_shift: f32,
    // --- persisted, not yet applied to rendering ---
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub fallback_stack: Vec<String>,
    #[serde(default)]
    pub font_style: Option<String>,
    #[serde(default)]
    pub variable_axes: std::collections::HashMap<String, f32>,
}

/// Selector type for a text animator.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum SelectorKind {
    Range,
    Wiggly,
    /// Accepted + persisted; evaluated as a full (100%) selection for now.
    Expression,
}

/// Range-selector falloff shape.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum RangeShape {
    Square,
    RampUp,
    RampDown,
    Triangle,
    Round,
    Smooth,
}

/// Accept either a bare number (legacy saved files, where animator params were
/// plain scalars) or a full `Track` object — so old projects keep loading now
/// that every animator parameter is keyframeable.
fn de_track<'de, D>(d: D) -> Result<Track, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrTrack {
        Num(f32),
        Track(Track),
    }
    Ok(match NumOrTrack::deserialize(d)? {
        NumOrTrack::Num(v) => Track::constant(v),
        NumOrTrack::Track(t) => t,
    })
}

/// Same, but for the 2-element `position` array — each element may be a bare
/// number (legacy `[x, y]`) or a `Track`.
fn de_pos<'de, D>(d: D) -> Result<[Track; 2], D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrTrack {
        Num(f32),
        Track(Track),
    }
    let items = <Vec<NumOrTrack>>::deserialize(d)?;
    let mut it = items.into_iter().map(|x| match x {
        NumOrTrack::Num(v) => Track::constant(v),
        NumOrTrack::Track(t) => t,
    });
    let x = it.next().unwrap_or_default();
    let y = it.next().unwrap_or_default();
    Ok([x, y])
}

fn pos_default() -> [Track; 2] {
    [Track::default(), Track::default()]
}

/// A text-animator selector. Range fields are percentages (0..100). Wiggly
/// randomises the per-character selection over time. Every numeric field is a
/// keyframeable `Track` — animate the selector's `offset` (or start/end) to
/// sweep the selection across the letters over time (the classic AE move).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AnimSelector {
    pub kind: SelectorKind,
    // --- Range ---
    #[serde(default, deserialize_with = "de_track")]
    pub start: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub end: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub offset: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub smoothness: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub ease_high: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub ease_low: Track,
    pub shape: RangeShape,
    // --- Wiggly ---
    #[serde(default, deserialize_with = "de_track")]
    pub wiggles_per_sec: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub amount: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub correlation: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub temporal_phase: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub spatial_phase: Track,
    pub seed: u32,
}

/// The per-character property offsets a text animator applies (scaled by the
/// selector amount). Units: position px, rotation/skew degrees, scale/opacity
/// percent (100 = no change), tracking/blur px, fill overrides the glyph colour.
/// Every numeric field is a keyframeable `Track`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AnimProps {
    #[serde(default = "pos_default", deserialize_with = "de_pos")]
    pub position: [Track; 2],
    #[serde(default, deserialize_with = "de_track")]
    pub scale: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub rotation: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub skew: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub skew_axis: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub opacity: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub tracking: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub blur: Track,
    pub fill: Option<Rgba>,
    /// Unicode code-point shift; persisted, not yet applied (needs reshape).
    pub char_offset: i32,
    /// Per-character 3D (only applied when the layer's `per_char_3d` is on):
    /// X/Y rotation in degrees and Z position in px.
    #[serde(default, deserialize_with = "de_track")]
    pub rotation_x: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub rotation_y: Track,
    #[serde(default, deserialize_with = "de_track")]
    pub position_z: Track,
}

/// One After Effects-style text animator: a selector + the properties it drives.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TextAnimator {
    pub selector: AnimSelector,
    pub props: AnimProps,
}

// --- Layer styles (whole-layer post-processing on the text) ---------------

/// Drop shadow layer style.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct DropShadow {
    pub color: Rgba,
    pub opacity: f32,  // 0..100 %
    pub angle: f32,    // degrees (light direction)
    pub distance: f32, // px
    pub size: f32,     // blur radius px
}

/// Inner or outer glow layer style.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TextGlow {
    pub color: Rgba,
    pub opacity: f32, // 0..100 %
    pub size: f32,    // px
    pub range: f32,   // 0..100 % edge falloff
    pub mode: BlendMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum BevelStyle {
    InnerBevel,
    OuterBevel,
    Emboss,
    PillowEmboss,
}

/// Bevel / emboss layer style (stylised: offset highlight + shadow copies).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct BevelEmboss {
    pub style: BevelStyle,
    pub depth: f32,   // %
    pub size: f32,    // px
    pub soften: f32,  // px
    pub angle: f32,   // degrees (light azimuth)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct GradientStop {
    pub position: f32, // 0..100 %
    pub color: Rgba,
}

/// Gradient overlay layer style.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct GradientOverlay {
    pub opacity: f32, // 0..100 %
    pub angle: f32,   // degrees
    pub blend: BlendMode,
    pub stops: Vec<GradientStop>,
}

/// The full set of non-destructive layer styles for a text layer.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TextLayerStyles {
    #[serde(default)]
    pub drop_shadow: Option<DropShadow>,
    #[serde(default)]
    pub outer_glow: Option<TextGlow>,
    #[serde(default)]
    pub inner_glow: Option<TextGlow>,
    #[serde(default)]
    pub bevel: Option<BevelEmboss>,
    #[serde(default)]
    pub gradient: Option<GradientOverlay>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum SurfaceShape {
    Box,
    Cylinder,
}

/// The 2D vector primitive a `Shape2D` layer draws.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum VectorShape {
    Rectangle,
    Circle,
    Polygon,
    /// A horizontal arrow (tail at left, head at right) spanning `width`, with
    /// `height` as its overall thickness. Rotate the layer to aim it.
    Arrow,
}

/// The paint style of a `Shape2D` layer. Every colour is keyframeable via its
/// `*_keys` list (empty = the static base colour, mirroring text colour); every
/// numeric knob is a keyframeable `Track`. Fields default to sensible values so
/// older projects and the frontend builder stay in sync.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Shape2DStyle {
    pub shape: VectorShape,
    /// Base bounding-box size in comp px (the layer transform scales/rotates on
    /// top). Keyframeable — animate the shape's own width/height. Bare numbers in
    /// older projects deserialize as constant tracks.
    #[serde(default = "size_track", deserialize_with = "de_track")]
    pub width: Track,
    #[serde(default = "size_track", deserialize_with = "de_track")]
    pub height: Track,
    /// Regular-polygon side count (>= 3, rounded when sampled). Ignored for
    /// rectangle/circle. Keyframeable so the polygon can morph side counts.
    #[serde(default = "sides_track", deserialize_with = "de_track")]
    pub sides: Track,
    /// Rectangle corner radius (px). Ignored for circle/polygon.
    #[serde(default)]
    pub corner_radius: Track,
    /// Arrow curvature (px): perpendicular offset of the shaft's midpoint, so the
    /// arrow bows into an arc. 0 = straight. Keyframeable. Ignored by other shapes.
    #[serde(default)]
    pub bend: Track,
    /// false = hollow (outline only, no fill) — the border/glow still draw.
    #[serde(default = "default_true")]
    pub filled: bool,
    // --- Fill ---
    pub fill: Rgba,
    #[serde(default, rename = "fillKeys")]
    pub fill_keys: Vec<ColorKey>,
    // --- Border / stroke ---
    #[serde(default)]
    pub border_width: Track,
    pub border_color: Rgba,
    #[serde(default, rename = "borderColorKeys")]
    pub border_color_keys: Vec<ColorKey>,
    // --- Outer glow (a coloured halo around the shape) ---
    pub glow_color: Rgba,
    #[serde(default, rename = "glowColorKeys")]
    pub glow_color_keys: Vec<ColorKey>,
    #[serde(default)]
    pub glow_size: Track,
    #[serde(default = "one_track")]
    pub glow_opacity: Track,
    // --- Drop shadow ---
    pub shadow_color: Rgba,
    #[serde(default, rename = "shadowColorKeys")]
    pub shadow_color_keys: Vec<ColorKey>,
    #[serde(default)]
    pub shadow_blur: Track,
    #[serde(default)]
    pub shadow_offset_x: Track,
    #[serde(default)]
    pub shadow_offset_y: Track,
    #[serde(default = "one_track")]
    pub shadow_opacity: Track,
}

fn default_sides() -> u32 {
    6
}
fn default_shape_size() -> f32 {
    300.0
}
fn size_track() -> Track {
    Track::constant(default_shape_size())
}
fn sides_track() -> Track {
    Track::constant(default_sides() as f32)
}
fn default_true() -> bool {
    true
}

impl Shape2DStyle {
    /// A new shape style with a light fill, no border/glow/shadow yet, and
    /// sensible defaults ready for the user to style.
    pub fn new(shape: VectorShape, size: f32) -> Self {
        // An arrow reads better wider than it is thick.
        let (width, height) = if shape == VectorShape::Arrow { (size, size * 0.5) } else { (size, size) };
        Shape2DStyle {
            shape,
            width: Track::constant(width),
            height: Track::constant(height),
            sides: Track::constant(default_sides() as f32),
            corner_radius: Track::constant(if shape == VectorShape::Rectangle { 24.0 } else { 0.0 }),
            bend: Track::constant(0.0),
            filled: true,
            fill: Rgba { r: 90, g: 150, b: 240, a: 255 },
            fill_keys: vec![],
            border_width: Track::constant(0.0),
            border_color: Rgba { r: 255, g: 255, b: 255, a: 255 },
            border_color_keys: vec![],
            glow_color: Rgba { r: 120, g: 200, b: 255, a: 255 },
            glow_color_keys: vec![],
            glow_size: Track::constant(0.0),
            glow_opacity: Track::constant(1.0),
            shadow_color: Rgba { r: 0, g: 0, b: 0, a: 255 },
            shadow_color_keys: vec![],
            shadow_blur: Track::constant(0.0),
            shadow_offset_x: Track::constant(0.0),
            shadow_offset_y: Track::constant(0.0),
            shadow_opacity: Track::constant(1.0),
        }
    }
}

/// Pins a layer (image or text) to a `Shape3D` so it renders as a decal on the
/// shape's surface. The placement is keyframeable, so the decal can be animated
/// *across the surface* independently of the shape's own motion: `(u, v)` is the
/// decal centre in surface coordinates (0..1), `scale` its size (image aspect
/// preserved), and `rotation` its in-plane spin (box faces only).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Decal {
    /// Id of the `Shape3D` layer this layer is pinned to.
    pub shape_id: u32,
    /// Which box face (0=front,1=back,2=left,3=right,4=top,5=bottom). For a
    /// cylinder this is ignored — the decal wraps the surface around `u`.
    pub face: u32,
    pub u: Track,
    pub v: Track,
    pub scale: Track,
    pub rotation: Track,
}

impl Decal {
    /// A decal pinned to `shape_id` on `face`, centred, at the given default
    /// size (constant tracks until the user keyframes them).
    pub fn new(shape_id: u32, face: u32, scale: f32) -> Self {
        Decal {
            shape_id,
            face,
            u: Track::constant(0.5),
            v: Track::constant(0.5),
            scale: Track::constant(scale),
            rotation: Track::constant(0.0),
        }
    }
}

/// A visual effect in a layer's effect stack. Most map to a CSS/canvas filter
/// (applied in order); `Wipe` is a directional gradient mask (the "fade left to
/// right" / reveal). The numeric parameters are keyframeable Tracks so an effect
/// can animate (e.g. a wipe sweeping across).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum Effect {
    /// Desaturate. amount 0 = colour, 1 = full black & white.
    Grayscale { amount: Track },
    /// Brightness multiplier (1 = normal).
    Brightness { amount: Track },
    /// Contrast multiplier (1 = normal).
    Contrast { amount: Track },
    /// Saturation multiplier (1 = normal, 0 = greyscale, >1 = vivid).
    Saturate { amount: Track },
    /// Gaussian blur radius in px.
    Blur { radius: Track },
    /// Hue rotation in degrees.
    Hue { degrees: Track },
    /// Invert colours. amount 0..1.
    Invert { amount: Track },
    /// Directional alpha wipe / fade. `angle` is the sweep direction (degrees,
    /// 0 = left→right). `position` 0..1 is the edge location (keyframe it to
    /// sweep). `softness` 0..1 is the fade width. `invert` flips which side shows.
    Wipe {
        angle: f32,
        position: Track,
        softness: Track,
        invert: bool,
    },
    /// Animated procedural "shiny clouds" — a drifting/morphing fBm caustic /
    /// light-leak pattern composited over the image on the GPU (WebGL). Every
    /// numeric knob is a keyframeable Track; `tint` (shine colour) and `blend`
    /// (0 Add · 1 Screen · 2 Overlay · 3 Soft Light) are static.
    ShinyClouds {
        intensity: Track,
        scale: Track,
        speed: Track,
        complexity: Track,
        contrast: Track,
        brightness: Track,
        opacity: Track,
        tint: Rgba,
        blend: u8,
    },
    /// A GPU overlay effect from the shared mega-shader (gpuOverlay.frag), picked
    /// by `effect` (1 Caustics · 2 Lens Flare · 3 Sparkle · 4 Heat Haze ·
    /// 5 Film Grain · 6 Vignette · 7 Shimmer · 8 Aurora · 9 Fog). The seven float
    /// slots are generic keyframeable knobs whose meaning depends on `effect`
    /// (see gpuOverlay.frag / the inspector). `tint`/`tint2`/`pos`/`blend` are
    /// static.
    GpuOverlay {
        effect: u8,
        intensity: Track,
        scale: Track,
        speed: Track,
        detail: Track,
        softness: Track,
        extra: Track,
        opacity: Track,
        tint: Rgba,
        tint2: Rgba,
        #[serde(default, rename = "posX")]
        pos_x: f32,
        #[serde(default, rename = "posY")]
        pos_y: f32,
        blend: u8,
    },
}

/// Opaque white — the default tint for most GPU-overlay effects.
const WHITE: Rgba = Rgba { r: 255, g: 255, b: 255, a: 255 };

impl Effect {
    /// Build a `GpuOverlay` effect. `p` is the seven float slots in order:
    /// [intensity, scale, speed, detail, softness, extra, opacity].
    fn gpu_overlay(effect: u8, p: [f32; 7], tint: Rgba, tint2: Rgba, pos_x: f32, pos_y: f32, blend: u8) -> Effect {
        Effect::GpuOverlay {
            effect,
            intensity: Track::constant(p[0]),
            scale: Track::constant(p[1]),
            speed: Track::constant(p[2]),
            detail: Track::constant(p[3]),
            softness: Track::constant(p[4]),
            extra: Track::constant(p[5]),
            opacity: Track::constant(p[6]),
            tint,
            tint2,
            pos_x,
            pos_y,
            blend,
        }
    }

    /// A new effect of the named kind with sensible default tracks.
    pub fn default_of(kind: &str) -> Option<Effect> {
        Some(match kind {
            "grayscale" => Effect::Grayscale { amount: Track::constant(1.0) },
            "brightness" => Effect::Brightness { amount: Track::constant(1.2) },
            "contrast" => Effect::Contrast { amount: Track::constant(1.2) },
            "saturate" => Effect::Saturate { amount: Track::constant(1.5) },
            "blur" => Effect::Blur { radius: Track::constant(6.0) },
            "hue" => Effect::Hue { degrees: Track::constant(90.0) },
            "invert" => Effect::Invert { amount: Track::constant(1.0) },
            "wipe" => Effect::Wipe {
                angle: 0.0,
                position: Track::ramp(0.0, 0, 1.0, 1000, Easing::EaseInOut),
                softness: Track::constant(0.15),
                invert: false,
            },
            "shinyclouds" => Effect::ShinyClouds {
                intensity: Track::constant(1.0),
                scale: Track::constant(1.0),
                speed: Track::constant(0.5),
                complexity: Track::constant(5.0),
                contrast: Track::constant(2.0),
                brightness: Track::constant(0.0),
                opacity: Track::constant(0.6),
                tint: Rgba { r: 255, g: 255, b: 255, a: 255 },
                blend: 1, // Screen — pleasant light-leak default
            },
            // GPU-overlay effects (shared mega-shader). Each is its own named
            // entry so it shows up individually in the Add-effect menu.
            "caustics" => Effect::gpu_overlay(1, [1.0, 1.5, 1.0, 3.0, 1.0, 0.0, 0.7],
                Rgba { r: 180, g: 230, b: 255, a: 255 }, WHITE, 0.5, 0.5, 1),
            "lensflare" => Effect::gpu_overlay(2, [1.0, 1.0, 0.5, 1.0, 0.5, 0.4, 0.9],
                Rgba { r: 255, g: 240, b: 210, a: 255 }, WHITE, 0.5, 0.4, 0),
            "sparkle" => Effect::gpu_overlay(3, [1.0, 1.0, 1.5, 40.0, 1.0, 0.12, 0.85],
                WHITE, WHITE, 0.5, 0.5, 0),
            "heathaze" => Effect::gpu_overlay(4, [1.0, 8.0, 1.0, 3.0, 1.0, 0.02, 0.85],
                WHITE, WHITE, 0.5, 0.5, 0),
            "filmgrain" => Effect::gpu_overlay(5, [0.25, 1.0, 1.0, 1.0, 1.0, 2.0, 0.8],
                WHITE, WHITE, 0.5, 0.5, 0),
            "vignette" => Effect::gpu_overlay(6, [0.8, 1.0, 0.5, 0.05, 1.0, 0.4, 1.0],
                Rgba { r: 0, g: 0, b: 0, a: 255 }, WHITE, 0.5, 0.5, 0),
            "shimmer" => Effect::gpu_overlay(7, [0.6, 1.0, 1.0, 4.0, 1.0, 0.0, 0.6],
                Rgba { r: 255, g: 120, b: 200, a: 255 }, Rgba { r: 120, g: 200, b: 255, a: 255 }, 0.5, 0.5, 1),
            "aurora" => Effect::gpu_overlay(8, [1.0, 2.0, 0.6, 3.0, 1.0, 0.15, 0.8],
                Rgba { r: 120, g: 255, b: 180, a: 255 }, Rgba { r: 120, g: 140, b: 255, a: 255 }, 0.5, 0.5, 1),
            "fog" => Effect::gpu_overlay(9, [1.0, 1.5, 0.5, 4.0, 0.45, 0.0, 0.6],
                Rgba { r: 200, g: 205, b: 215, a: 255 }, WHITE, 0.5, 0.5, 1),
            // Flap: detail=angle°, softness=orientation(0 horizontal/1 vertical),
            // extra=perspective, pos_x=axis position, opacity=final. Keyframe the
            // angle to animate the tilt.
            "flap" => Effect::gpu_overlay(10, [1.0, 1.0, 0.0, 30.0, 0.0, 0.5, 1.0],
                WHITE, WHITE, 0.5, 0.5, 0),
            _ => return None,
        })
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
    /// A blank project — the app opens with an empty timeline (no layers).
    pub fn empty() -> Self {
        Project {
            width: 1920,
            height: 1080,
            fps: 30,
            duration_ms: 4000,
            layers: vec![],
            media: vec![],
        }
    }

    /// A small demo project (dark backdrop, an accent square that scales/fades
    /// in, and a title that rises in). Kept for the evaluator tests; the app now
    /// opens with `empty()`.
    #[cfg(test)]
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
            attach: None,
            effects: vec![],
            transition_in: None,
            transition_out: None,
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
            attach: None,
            effects: vec![],
            transition_in: None,
            transition_out: None,
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
                color_keys: vec![],
                font: Font("Vazirmatn".into()),
                weight: 400,
                italic: false,
                anim: Some(LetterAnimation {
                    preset: LetterPreset::RiseUp,
                    start_ms: 300,
                    duration_ms: 700,
                    stagger_ms: 70,
                    area_px: 500.0,
                }),
                parts: vec![],
                decompose: Track::constant(0.0),
                style: None,
                animators: vec![],
                layer_styles: None,
                per_char_3d: false,
                per_char_rx: 0.0,
                per_char_ry: 0.0,
                per_char_spread: 0.0,
            },
            transform: Transform::at(cx, cy + 70.0),
            hidden: false,
            attach: None,
            effects: vec![],
            transition_in: None,
            transition_out: None,
        };

        Project {
            width: w,
            height: h,
            fps: 30,
            duration_ms: 4000,
            layers: vec![backdrop, accent, title],
            media: vec![],
        }
    }
}
