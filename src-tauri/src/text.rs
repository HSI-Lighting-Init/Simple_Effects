//! Text shaping.
//!
//! Arabic/Persian is cursive: letters change form by position and join to their
//! neighbours. You cannot split a string into chars and render them separately
//! without breaking the joining. So we shape the whole run with rustybuzz
//! (HarfBuzz) — which handles RTL, contextual forms, ligatures and ZWNJ — then
//! pull each glyph's outline with ttf-parser. Per-letter animation then moves
//! these already-correct glyphs around.
//!
//! The same shaped outlines feed both the preview and (later) the tiny-skia
//! export, so what you see matches what you render.

use std::collections::BTreeSet;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A font choice: a family NAME. The four built-ins below are always available
/// (embedded, SIL OFL, Persian/Arabic + Latin); any other name is resolved from
/// the system font database. Rendering as outlines means any font explodes into
/// shapes, so no runtime font is needed once shaped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(transparent)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Font(pub String);

/// Horizontal alignment of a multi-line text run: each line is offset within the
/// widest line's box.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum TextAlign {
    Left,
    /// Default: the text block is centred on the layer's anchor point (matches the
    /// original behaviour before alignment existed).
    #[default]
    Center,
    Right,
    /// Stretch each line (except the last) to the full width by widening spaces.
    Justify,
}

const VAZIRMATN: &[u8] = include_bytes!("../fonts/Vazirmatn-Regular.ttf");
const SAHEL: &[u8] = include_bytes!("../fonts/Sahel.ttf");
const SHABNAM: &[u8] = include_bytes!("../fonts/Shabnam.ttf");
const GANDOM: &[u8] = include_bytes!("../fonts/Gandom.ttf");
const BUILTINS: [&str; 4] = ["Vazirmatn", "Sahel", "Shabnam", "Gandom"];

/// Build a fresh font database: the OS system fonts plus the Windows per-user
/// fonts directory (where fonts installed without admin land, and which
/// `load_system_fonts` can miss).
fn build_db() -> fontdb::Database {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let mut dir = std::path::PathBuf::from(local);
        dir.push("Microsoft");
        dir.push("Windows");
        dir.push("Fonts");
        if dir.is_dir() {
            db.load_fonts_dir(dir);
        }
    }
    db
}

/// The system font database, behind an RwLock so it can be reloaded at runtime
/// (to pick up newly-installed fonts without restarting).
fn db() -> &'static RwLock<fontdb::Database> {
    static DB: OnceLock<RwLock<fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| RwLock::new(build_db()))
}

/// Re-scan the OS for fonts (call before listing so new installs show up, and so
/// they're resolvable when shaping).
pub fn reload_fonts() {
    if let Ok(mut guard) = db().write() {
        *guard = build_db();
    }
}

/// Resolve a family name (plus the requested weight/italic) to font bytes + face
/// index. Built-ins are embedded (single face each, so weight/italic are honoured
/// synthetically at shape time); everything else queries the system db for the
/// closest matching face, falling back to Vazirmatn.
///
/// Returns the bytes, the face index, and the weight/italic the *chosen* face
/// actually provides — so the caller can synthesise the difference (fake-bold /
/// fake-italic) when the family has no matching real face (e.g. the single-face
/// built-ins, or a family with a Regular but no Bold).
fn font_data(family: &str, weight: u16, italic: bool) -> (Vec<u8>, u32, u16, bool) {
    match family {
        "Vazirmatn" => return (VAZIRMATN.to_vec(), 0, 400, false),
        "Sahel" => return (SAHEL.to_vec(), 0, 400, false),
        "Shabnam" => return (SHABNAM.to_vec(), 0, 400, false),
        "Gandom" => return (GANDOM.to_vec(), 0, 400, false),
        _ => {}
    }
    if let Ok(db) = db().read() {
        let query = fontdb::Query {
            families: &[fontdb::Family::Name(family)],
            weight: fontdb::Weight(weight),
            style: if italic { fontdb::Style::Italic } else { fontdb::Style::Normal },
            ..Default::default()
        };
        if let Some(id) = db.query(&query) {
            let info = db.face(id).map(|f| (f.weight.0, f.style != fontdb::Style::Normal));
            if let Some(data) = db.with_face_data(id, |data, index| (data.to_vec(), index)) {
                let (gw, gi) = info.unwrap_or((weight, italic));
                return (data.0, data.1, gw, gi);
            }
        }
    }
    (VAZIRMATN.to_vec(), 0, 400, false)
}

/// One selectable face (style) of a family: a human name plus the weight/italic
/// it maps to. The frontend shows `name` and stores `weight`/`italic`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct FontFace {
    pub name: String,
    pub weight: u16,
    pub italic: bool,
}

/// CSS-weight → human name (the labels users expect: Thin … Black).
fn weight_name(w: u16) -> &'static str {
    match w {
        0..=149 => "Thin",
        150..=249 => "Extra Light",
        250..=349 => "Light",
        350..=449 => "Regular",
        450..=549 => "Medium",
        550..=649 => "Semi Bold",
        650..=749 => "Bold",
        750..=849 => "Extra Bold",
        _ => "Black",
    }
}

fn face_label(weight: u16, italic: bool) -> String {
    let base = weight_name(weight);
    match (base, italic) {
        ("Regular", true) => "Italic".to_string(),
        (_, true) => format!("{base} Italic"),
        (_, false) => base.to_string(),
    }
}

/// Every available style (face) of one family, as installed. Built-ins are
/// single-face embedded fonts whose weight/italic we synthesise, so they offer
/// the useful synthetic variants; system families report their real faces
/// (deduped by weight + italic, sorted light→heavy, upright before italic).
pub fn list_font_styles(family: &str) -> Vec<FontFace> {
    if BUILTINS.contains(&family) {
        return [(400, false), (400, true), (700, false), (700, true)]
            .into_iter()
            .map(|(weight, italic)| FontFace { name: face_label(weight, italic), weight, italic })
            .collect();
    }
    let mut seen = BTreeSet::new();
    let mut out: Vec<FontFace> = Vec::new();
    if let Ok(db) = db().read() {
        for face in db.faces() {
            if face.families.iter().any(|(n, _)| n == family) {
                let italic = face.style != fontdb::Style::Normal;
                let weight = face.weight.0;
                if seen.insert((weight, italic)) {
                    out.push(FontFace { name: face_label(weight, italic), weight, italic });
                }
            }
        }
    }
    out.sort_by(|a, b| a.weight.cmp(&b.weight).then(a.italic.cmp(&b.italic)));
    if out.is_empty() {
        out.push(FontFace { name: "Regular".into(), weight: 400, italic: false });
    }
    out
}

/// All selectable font families: the built-ins first, then every system family
/// (sorted, de-duplicated).
pub fn list_font_families() -> Vec<String> {
    let mut system: BTreeSet<String> = BTreeSet::new();
    if let Ok(db) = db().read() {
        for face in db.faces() {
            for (name, _lang) in &face.families {
                system.insert(name.clone());
            }
        }
    }
    for b in BUILTINS {
        system.remove(b);
    }
    let mut out: Vec<String> = BUILTINS.iter().map(|s| s.to_string()).collect();
    out.extend(system);
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ShapedGlyph {
    /// SVG path data in pixel space, origin at the glyph's pen point (baseline).
    pub d: String,
    /// Pen x of this glyph within the run (px), including line alignment.
    pub x: f32,
    /// Baseline y of this glyph's line, relative to the first line (px). 0 for a
    /// single-line run; each subsequent line is one `line_height` lower.
    #[serde(default)]
    pub y: f32,
    /// Horizontal advance (px).
    pub advance: f32,
    /// Glyph bounding-box centre in local px (for centred scale/rotate).
    pub cx: f32,
    pub cy: f32,
    /// Source byte cluster — maps a glyph back to the character it came from.
    pub cluster: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ShapedText {
    pub glyphs: Vec<ShapedGlyph>,
    /// Total advance width of the run (px).
    pub width: f32,
    /// Scaled ascender / descender (px, both positive) — of a single line.
    pub ascender: f32,
    pub descender: f32,
    /// Baseline-to-baseline distance between lines (px).
    #[serde(default)]
    pub line_height: f32,
    /// Number of lines in the run (>= 1).
    #[serde(default)]
    pub lines: u32,
    /// Synthetic-bold stroke width (px) to add when the family has no real face
    /// heavier than the chosen one. 0 = the outlines are already the right weight
    /// (a real Bold/Medium face was found), so the renderer just fills them.
    #[serde(default)]
    pub embolden: f32,
}

/// Builds an SVG path string from a glyph outline, baking in the px scale and
/// the Y-flip (font space is Y-up, screen space is Y-down).
/// Synthetic-italic slant: horizontal shear applied to every outline point
/// (≈12.4°). Only used when the family has no real italic face.
const SYNTH_SLANT: f32 = 0.22;

struct PathBuilder {
    d: String,
    s: f32,
    /// Shear factor for fake-italic (0 = upright). Applied in screen space, where
    /// the baseline is y=0 and ascenders are negative, so the top leans right.
    shear: f32,
}
impl PathBuilder {
    /// Font point (font-up units) → screen coords (px, y-down), with the italic
    /// shear folded in.
    fn map(&self, x: f32, y: f32) -> (f32, f32) {
        let sx = x * self.s;
        let sy = -y * self.s;
        (sx - self.shear * sy, sy)
    }
}
impl ttf_parser::OutlineBuilder for PathBuilder {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.map(x, y);
        self.d.push_str(&format!("M{x:.2} {y:.2} "));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.map(x, y);
        self.d.push_str(&format!("L{x:.2} {y:.2} "));
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (x1, y1) = self.map(x1, y1);
        let (x, y) = self.map(x, y);
        self.d.push_str(&format!("Q{x1:.2} {y1:.2} {x:.2} {y:.2} "));
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (x1, y1) = self.map(x1, y1);
        let (x2, y2) = self.map(x2, y2);
        let (x, y) = self.map(x, y);
        self.d.push_str(&format!("C{x1:.2} {y1:.2} {x2:.2} {y2:.2} {x:.2} {y:.2} "));
    }
    fn close(&mut self) {
        self.d.push_str("Z ");
    }
}

/// Shape `content` at `size` px with `font` (of the given weight/italic) into
/// positioned glyph outlines. A real matching face is preferred; when the family
/// offers none, the difference is synthesised — italic as an outline shear,
/// bold as an `embolden` stroke width the renderer applies.
pub fn shape(content: &str, size: f32, font: &Font, weight: u16, italic: bool) -> ShapedText {
    shape_aligned(content, size, font, weight, italic, TextAlign::Left)
}

/// Like [`shape`], but lays multiple lines (split on `'\n'`) out vertically and
/// horizontally aligns each within the widest line.
pub fn shape_aligned(
    content: &str,
    size: f32,
    font: &Font,
    weight: u16,
    italic: bool,
    align: TextAlign,
) -> ShapedText {
    let (mut bytes, mut index, got_weight, got_italic) = font_data(&font.0, weight, italic);
    // Guard against an unparseable system font — fall back to a built-in.
    if ttf_parser::Face::parse(&bytes, index).is_err() || rustybuzz::Face::from_slice(&bytes, index).is_none() {
        bytes = VAZIRMATN.to_vec();
        index = 0;
    }
    // Synthesise what the chosen face doesn't already provide.
    let shear = if italic && !got_italic { SYNTH_SLANT } else { 0.0 };
    let weight_gap = (weight as i32 - got_weight as i32).max(0) as f32;
    // ~0.4px of stroke per 100 weight-steps at 100px, clamped so it never blobs.
    let embolden = (weight_gap / 100.0 * 0.004 * size).min(size * 0.05);
    let rb_face = rustybuzz::Face::from_slice(&bytes, index).expect("font is valid");
    let ttf = ttf_parser::Face::parse(&bytes, index).expect("font is valid");
    let upem = ttf.units_per_em() as f32;
    let s = size / upem;
    let ascender = ttf.ascender() as f32 * s;
    let descender = (ttf.descender() as f32 * s).abs();
    let line_height = (ttf.ascender() - ttf.descender() + ttf.line_gap()) as f32 * s;

    // Shape each line (split on '\n') independently: pen x within the line, plus
    // the line width. Clusters stay global (offset by the line's byte start) so
    // per-letter animation still maps glyphs to characters across lines.
    struct LineShaped {
        glyphs: Vec<ShapedGlyph>,
        /// Per-glyph flag: is this glyph a space (a justification gap)?
        space: Vec<bool>,
        width: f32,
    }
    let mut lines: Vec<LineShaped> = Vec::new();
    let mut byte_off = 0u32;
    for raw in content.split('\n') {
        let line_str = raw.strip_suffix('\r').unwrap_or(raw); // tolerate CRLF
        let bytes = line_str.as_bytes();
        let mut buffer = rustybuzz::UnicodeBuffer::new();
        buffer.push_str(line_str);
        // Auto-detect script/direction/language (RTL + Arabic for Persian).
        buffer.guess_segment_properties();
        let shaped = rustybuzz::shape(&rb_face, &[], buffer);
        let infos = shaped.glyph_infos();
        let positions = shaped.glyph_positions();
        let mut gs = Vec::with_capacity(infos.len());
        let mut space = Vec::with_capacity(infos.len());
        let mut pen = 0.0f32;
        for (info, pos) in infos.iter().zip(positions.iter()) {
            let gid = ttf_parser::GlyphId(info.glyph_id as u16);
            let mut b = PathBuilder { d: String::new(), s, shear };
            let bbox = ttf.outline_glyph(gid, &mut b);
            // Centre of the glyph's bounding box (local px), Y already flipped.
            let (cx, cy) = match bbox {
                Some(r) => (
                    (r.x_min as f32 + r.x_max as f32) * 0.5 * s,
                    -(r.y_min as f32 + r.y_max as f32) * 0.5 * s,
                ),
                None => (pos.x_advance as f32 * s * 0.5, -size * 0.3),
            };
            gs.push(ShapedGlyph {
                d: b.d,
                x: pen + pos.x_offset as f32 * s,
                y: 0.0, // filled in the layout pass below
                advance: pos.x_advance as f32 * s,
                cx,
                cy,
                cluster: byte_off + info.cluster,
            });
            space.push(bytes.get(info.cluster as usize) == Some(&b' '));
            pen += pos.x_advance as f32 * s;
        }
        lines.push(LineShaped { glyphs: gs, space, width: pen });
        byte_off += raw.len() as u32 + 1; // + the consumed '\n'
    }

    // Layout pass: stack lines vertically and align each within the widest line.
    let max_width = lines.iter().map(|l| l.width).fold(0.0f32, f32::max);
    let line_count = lines.len().max(1) as u32;
    let mut glyphs = Vec::new();
    for (li, line) in lines.iter_mut().enumerate() {
        let y_off = li as f32 * line_height;
        let is_last = li as u32 + 1 == line_count;
        // Justify: widen the spaces so the line fills the full width (last line and
        // space-less lines fall back to left alignment).
        if align == TextAlign::Justify && !is_last {
            let gaps = line.space.iter().filter(|&&s| s).count();
            let slack = (max_width - line.width).max(0.0);
            if gaps > 0 && slack > 0.0 {
                let extra = slack / gaps as f32;
                let mut added = 0.0f32;
                let spaces = std::mem::take(&mut line.space);
                for (g, is_sp) in line.glyphs.drain(..).zip(spaces) {
                    glyphs.push(ShapedGlyph { x: g.x + added, y: y_off, ..g });
                    if is_sp {
                        added += extra;
                    }
                }
                continue;
            }
        }
        let x_off = match align {
            TextAlign::Left | TextAlign::Justify => 0.0,
            TextAlign::Center => (max_width - line.width) * 0.5,
            TextAlign::Right => max_width - line.width,
        };
        for g in line.glyphs.drain(..) {
            glyphs.push(ShapedGlyph { x: g.x + x_off, y: y_off, ..g });
        }
    }

    ShapedText {
        glyphs,
        width: max_width,
        ascender,
        descender,
        line_height,
        lines: line_count,
        embolden,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_persian_into_joined_glyphs() {
        // The example string the client cares about — across every built-in font.
        for name in ["Vazirmatn", "Sahel", "Shabnam", "Gandom"] {
            let font = Font(name.to_string());
            let st = shape("آموزش اتوکد پی‌دی‌اف رایگان", 88.0, &font, 400, false);
            assert!(st.width > 0.0, "run should have width for {name}");
            assert!(st.glyphs.len() > 5, "should produce many glyphs for {name}");
            let with_outline = st.glyphs.iter().filter(|g| !g.d.is_empty()).count();
            assert!(with_outline > 5, "most glyphs should have outlines for {name}");
        }
    }

    #[test]
    fn latin_advances_left_to_right() {
        let st = shape("AV", 100.0, &Font("Vazirmatn".to_string()), 400, false);
        assert_eq!(st.glyphs.len(), 2);
        assert!(st.glyphs[1].x > st.glyphs[0].x);
    }

    #[test]
    fn unknown_font_falls_back() {
        let st = shape("AV", 100.0, &Font("Totally Not A Real Font 123".to_string()), 400, false);
        assert_eq!(st.glyphs.len(), 2);
    }

    #[test]
    fn builtin_synthesises_bold_and_italic() {
        // A built-in has a single face, so weight/italic must be synthesised.
        let font = Font("Vazirmatn".to_string());
        let reg = shape("A", 100.0, &font, 400, false);
        let bold = shape("A", 100.0, &font, 700, false);
        assert_eq!(reg.embolden, 0.0);
        assert!(bold.embolden > 0.0, "bold should carry a synthetic stroke");
        // Italic shears the outline, so its path differs from upright.
        let ital = shape("A", 100.0, &font, 400, true);
        assert_ne!(reg.glyphs[0].d, ital.glyphs[0].d, "italic should slant the outline");
    }
}

#[cfg(test)]
mod justify_tests {
    use super::*;

    #[test]
    fn justify_spreads_short_nonlast_line() {
        // Two lines: a short first line and a long last line. Justify should push
        // the first line's trailing glyph out toward the long line's width.
        let font = Font("Vazirmatn".to_string());
        let left = shape_aligned("a b\nlonger line here", 40.0, &font, 400, false, TextAlign::Left);
        let just = shape_aligned("a b\nlonger line here", 40.0, &font, 400, false, TextAlign::Justify);
        // Last glyph of the FIRST line (line y == 0) — its x should move right.
        let last_left = left.glyphs.iter().filter(|g| g.y == 0.0).map(|g| g.x).fold(0.0f32, f32::max);
        let last_just = just.glyphs.iter().filter(|g| g.y == 0.0).map(|g| g.x).fold(0.0f32, f32::max);
        assert!(last_just > last_left + 1.0, "justify should spread the short line: {last_left} -> {last_just}");
    }
}
