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

/// Resolve a family name to font bytes + face index. Built-ins are embedded;
/// everything else comes from the system db, falling back to Vazirmatn.
fn font_data(family: &str) -> (Vec<u8>, u32) {
    match family {
        "Vazirmatn" => return (VAZIRMATN.to_vec(), 0),
        "Sahel" => return (SAHEL.to_vec(), 0),
        "Shabnam" => return (SHABNAM.to_vec(), 0),
        "Gandom" => return (GANDOM.to_vec(), 0),
        _ => {}
    }
    if let Ok(db) = db().read() {
        let query = fontdb::Query {
            families: &[fontdb::Family::Name(family)],
            ..Default::default()
        };
        if let Some(id) = db.query(&query) {
            if let Some(data) = db.with_face_data(id, |data, index| (data.to_vec(), index)) {
                return data;
            }
        }
    }
    (VAZIRMATN.to_vec(), 0)
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
    /// Pen x of this glyph within the run (px).
    pub x: f32,
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
    /// Scaled ascender / descender (px, both positive).
    pub ascender: f32,
    pub descender: f32,
}

/// Builds an SVG path string from a glyph outline, baking in the px scale and
/// the Y-flip (font space is Y-up, screen space is Y-down).
struct PathBuilder {
    d: String,
    s: f32,
}
impl ttf_parser::OutlineBuilder for PathBuilder {
    fn move_to(&mut self, x: f32, y: f32) {
        self.d.push_str(&format!("M{:.2} {:.2} ", x * self.s, -y * self.s));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.d.push_str(&format!("L{:.2} {:.2} ", x * self.s, -y * self.s));
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.d.push_str(&format!(
            "Q{:.2} {:.2} {:.2} {:.2} ",
            x1 * self.s, -y1 * self.s, x * self.s, -y * self.s
        ));
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.d.push_str(&format!(
            "C{:.2} {:.2} {:.2} {:.2} {:.2} {:.2} ",
            x1 * self.s, -y1 * self.s, x2 * self.s, -y2 * self.s, x * self.s, -y * self.s
        ));
    }
    fn close(&mut self) {
        self.d.push_str("Z ");
    }
}

/// Shape `content` at `size` px with `font` into positioned glyph outlines.
pub fn shape(content: &str, size: f32, font: &Font) -> ShapedText {
    let (mut bytes, mut index) = font_data(&font.0);
    // Guard against an unparseable system font — fall back to a built-in.
    if ttf_parser::Face::parse(&bytes, index).is_err() || rustybuzz::Face::from_slice(&bytes, index).is_none() {
        bytes = VAZIRMATN.to_vec();
        index = 0;
    }
    let rb_face = rustybuzz::Face::from_slice(&bytes, index).expect("font is valid");
    let ttf = ttf_parser::Face::parse(&bytes, index).expect("font is valid");
    let upem = ttf.units_per_em() as f32;
    let s = size / upem;

    let mut buffer = rustybuzz::UnicodeBuffer::new();
    buffer.push_str(content);
    // Auto-detect script/direction/language (RTL + Arabic for Persian).
    buffer.guess_segment_properties();
    let shaped = rustybuzz::shape(&rb_face, &[], buffer);

    let infos = shaped.glyph_infos();
    let positions = shaped.glyph_positions();

    let mut glyphs = Vec::with_capacity(infos.len());
    let mut pen = 0.0f32;
    for (info, pos) in infos.iter().zip(positions.iter()) {
        let gid = ttf_parser::GlyphId(info.glyph_id as u16);
        let mut b = PathBuilder { d: String::new(), s };
        let bbox = ttf.outline_glyph(gid, &mut b);

        // Centre of the glyph's bounding box (local px), Y already flipped.
        let (cx, cy) = match bbox {
            Some(r) => (
                (r.x_min as f32 + r.x_max as f32) * 0.5 * s,
                -(r.y_min as f32 + r.y_max as f32) * 0.5 * s,
            ),
            None => (pos.x_advance as f32 * s * 0.5, -size * 0.3),
        };

        glyphs.push(ShapedGlyph {
            d: b.d,
            x: pen + pos.x_offset as f32 * s,
            advance: pos.x_advance as f32 * s,
            cx,
            cy,
            cluster: info.cluster,
        });
        pen += pos.x_advance as f32 * s;
    }

    ShapedText {
        glyphs,
        width: pen,
        ascender: ttf.ascender() as f32 * s,
        descender: (ttf.descender() as f32 * s).abs(),
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
            let st = shape("آموزش اتوکد پی‌دی‌اف رایگان", 88.0, &font);
            assert!(st.width > 0.0, "run should have width for {name}");
            assert!(st.glyphs.len() > 5, "should produce many glyphs for {name}");
            let with_outline = st.glyphs.iter().filter(|g| !g.d.is_empty()).count();
            assert!(with_outline > 5, "most glyphs should have outlines for {name}");
        }
    }

    #[test]
    fn latin_advances_left_to_right() {
        let st = shape("AV", 100.0, &Font("Vazirmatn".to_string()));
        assert_eq!(st.glyphs.len(), 2);
        assert!(st.glyphs[1].x > st.glyphs[0].x);
    }

    #[test]
    fn unknown_font_falls_back() {
        let st = shape("AV", 100.0, &Font("Totally Not A Real Font 123".to_string()));
        assert_eq!(st.glyphs.len(), 2);
    }
}
