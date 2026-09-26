//! Reference-export analysis. Phase 0.2 of the template-extractor roadmap
//! (docs/TEMPLATE_EXTRACTOR_ROADMAP.md): `audit_export` is the checker built
//! *before* attempting the handoff §11.1 fix, so there's an automated way to
//! know a fix actually worked instead of another sparse manual spot-check.
//! Deterministic, no AI calls, no network.
//!
//! `extract_frames` — fast-seek single-frame grabs (for a human/Claude-facing
//! sheet) — and `audit_export`'s own bulk low-res scan (for the numeric check)
//! are deliberately two different ffmpeg passes: one wants a few frames at real
//! quality, the other wants every frame in the video at the ~17x16 px a
//! fingerprint actually needs, in one streamed pass.

use std::io::Read;
use std::process::Stdio;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use ts_rs::TS;

use crate::model::{LayerKind, Project};
use crate::{find_ffmpeg, quiet_command};

// --- Fingerprint: a dHash (256-bit luminance-gradient hash, 16 rows x 16
// horizontal-gradient bits from a 17x16 image) PLUS the same 17x16 downsample's
// mean RGB. dHash alone compares only relative *luminance* structure between
// adjacent pixels — by design, so a grade (brightness/contrast) doesn't break
// a match — but that also means it's blind to hue: calibrating against the
// known-bad export (handoff §11.1), two genuinely different images (a warm
// photo vs. a cool-toned graphic) that happen to share rough luminance
// structure separated by only ~2 bits of 256 on dHash alone, nowhere near
// enough to tell a real swap from noise. Mean colour closes that gap; distance
// combines both. ---

#[derive(Clone, Copy, PartialEq, Eq)]
struct DHash([u64; 4]);

#[derive(Clone, Copy)]
struct Fingerprint {
    dhash: DHash,
    mean_rgb: [f32; 3],
}

fn fingerprint_from_rgb_17x16(px: &[u8]) -> Fingerprint {
    debug_assert_eq!(px.len(), 17 * 16 * 3, "expected a 17x16 RGB buffer");
    let lum = |o: usize| -> f32 {
        0.299 * px[o] as f32 + 0.587 * px[o + 1] as f32 + 0.114 * px[o + 2] as f32
    };
    let mut bits = [0u64; 4];
    let mut i = 0usize;
    for row in 0..16 {
        for col in 0..16 {
            let left = lum((row * 17 + col) * 3);
            let right = lum((row * 17 + col + 1) * 3);
            if left > right {
                bits[i / 64] |= 1u64 << (i % 64);
            }
            i += 1;
        }
    }
    let mut sum = [0f64; 3];
    for p in px.chunks_exact(3) {
        sum[0] += p[0] as f64;
        sum[1] += p[1] as f64;
        sum[2] += p[2] as f64;
    }
    let n = (px.len() / 3) as f64;
    Fingerprint {
        dhash: DHash(bits),
        mean_rgb: [(sum[0] / n) as f32, (sum[1] / n) as f32, (sum[2] / n) as f32],
    }
}

fn hamming(a: DHash, b: DHash) -> u32 {
    (0..4).map(|i| (a.0[i] ^ b.0[i]).count_ones()).sum()
}

/// Combined distance: dHash Hamming bits (0..256) plus the mean-RGB Euclidean
/// distance (0..~441 for 8-bit channels) at COLOR_WEIGHT so a full-scale colour
/// mismatch counts for roughly as much as a full-scale structural one.
const COLOR_WEIGHT: f32 = 0.5;

fn distance(a: &Fingerprint, b: &Fingerprint) -> f32 {
    let hbits = hamming(a.dhash, b.dhash) as f32;
    let dr = a.mean_rgb[0] - b.mean_rgb[0];
    let dg = a.mean_rgb[1] - b.mean_rgb[1];
    let db = a.mean_rgb[2] - b.mean_rgb[2];
    let color = (dr * dr + dg * dg + db * db).sqrt();
    hbits + COLOR_WEIGHT * color
}

fn min_distance(frame: &Fingerprint, variants: &[Fingerprint]) -> f32 {
    variants.iter().map(|v| distance(frame, v)).fold(f32::MAX, f32::min)
}

/// A source image's fingerprint at several center-crop zoom levels, not just
/// the whole frame. A rendered frame is the source *after* whatever Ken Burns
/// scale is active at that instant — comparing it only to the untouched full
/// image means even a correct match can score as badly as a real mismatch once
/// the shot is zoomed in. These coarse crops (contain-fit exact) absorb that
/// without needing the actual transform: matching takes the minimum distance
/// across variants.
fn fingerprint_variants_of_file(path: &str) -> Result<Vec<Fingerprint>, String> {
    let img = image::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let (w, h) = (img.width(), img.height());
    let mut variants = Vec::with_capacity(4);
    for frac in [1.0f32, 0.85, 0.70, 0.55] {
        let cw = ((w as f32) * frac).round().max(1.0) as u32;
        let ch = ((h as f32) * frac).round().max(1.0) as u32;
        let cx = w.saturating_sub(cw) / 2;
        let cy = h.saturating_sub(ch) / 2;
        let rgb = img
            .crop_imm(cx, cy, cw, ch)
            .resize_exact(17, 16, image::imageops::FilterType::Triangle)
            .to_rgb8();
        variants.push(fingerprint_from_rgb_17x16(rgb.as_raw()));
    }
    Ok(variants)
}

/// Extract frames at exact timestamps via ffmpeg fast-seek (`-ss` before `-i`),
/// each downscaled to `short_side` px on its short edge. Returns `(t_ms, png
/// bytes)` pairs in the order given; a timestamp ffmpeg can't produce a frame
/// for (past the end of the file, say) is silently dropped — callers must not
/// assume the output is the same length as `times_ms`.
pub(crate) fn extract_frames(
    path: &str,
    times_ms: &[u32],
    short_side: u32,
) -> Result<Vec<(u32, Vec<u8>)>, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found — install it to use audit_export")?;
    let mut out = Vec::with_capacity(times_ms.len());
    for &t in times_ms {
        let ts = format!("{:.3}", t as f64 / 1000.0);
        let scale = format!("scale={short_side}:-2");
        let output = quiet_command(&ffmpeg)
            .args([
                "-ss", &ts, "-i", path, "-frames:v", "1", "-vf", &scale, "-f", "image2pipe",
                "-vcodec", "png", "-",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| format!("ffmpeg: {e}"))?;
        if output.status.success() && !output.stdout.is_empty() {
            out.push((t, output.stdout));
        }
    }
    Ok(out)
}

/// One streamed ffmpeg pass: every frame of `path` at 4 fps (250ms apart, per
/// the roadmap), decoded directly to 17x16 RGB — exactly the fingerprint input
/// size, so there's no separate resize step and nothing but this one small
/// buffer is ever held per frame. `-i` only (no `-ss`) because we want *every*
/// frame, not a seek.
fn bulk_scan(path: &str) -> Result<Vec<(u32, Fingerprint)>, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found — install it to use audit_export")?;
    let mut child = quiet_command(&ffmpeg)
        .args([
            "-i", path, "-vf", "fps=4,scale=17:16", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no ffmpeg stdout")?;
    let mut buf = Vec::new();
    stdout
        .read_to_end(&mut buf)
        .map_err(|e| format!("read ffmpeg output: {e}"))?;
    let _ = child.wait();
    const FRAME_BYTES: usize = 17 * 16 * 3;
    let mut out = Vec::with_capacity(buf.len() / FRAME_BYTES);
    for (i, chunk) in buf.chunks_exact(FRAME_BYTES).enumerate() {
        let t_ms = (i as f64 * 250.0).round() as u32; // fps=4 => one frame per 250ms
        out.push((t_ms, fingerprint_from_rgb_17x16(chunk)));
    }
    Ok(out)
}

/// A fingerprint distance beyond which it no longer counts as "this frame
/// shows that image" at all (dHash bits 0..256 + colour 0..~220 at
/// COLOR_WEIGHT).
/// ponytail: calibrated once, on one known-bad export (handoff §11.1) — revisit
/// if a legitimate frame (heavy grade/effects/motion blur) starts getting
/// flagged, or a real mismatch stops being caught.
const MATCH_THRESHOLD: f32 = 130.0;
/// How much better a non-expected source has to match than the best expected
/// one before we call it a swap rather than noise (mid-crossfade blends push
/// every distance up a bit; this margin keeps that from reading as a flag).
/// Calibrated low on purpose: on the known-bad export, the corrupted frames
/// were often a near-tie (a blend of the wrong content into the right one, not
/// a full swap) rather than a landslide — a few extra borderline flags for a
/// human/Claude to look at beats missing a real one outright.
const SWAP_MARGIN: f32 = 3.0;

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AuditSuspect {
    pub t_ms: u32,
    /// The image-layer source whose fingerprint is closest to this frame, if
    /// any.
    pub best_match_src: Option<String>,
    pub best_match_dist: f32,
    /// Image-layer sources the project says should be visible at `t_ms`.
    pub expected_srcs: Vec<String>,
    /// The closest distance among only the expected sources (None if none are
    /// expected at all — e.g. a frame past the comp's last image layer).
    pub expected_best_dist: Option<f32>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AuditReport {
    pub total_frames: usize,
    pub suspects: Vec<AuditSuspect>,
    /// Every scanned frame's numbers, flagged or not — only populated when
    /// `verbose` is requested (calibration; normal audits don't need it).
    pub all_frames: Option<Vec<AuditSuspect>>,
    /// A tiled JPEG data URL of up to 16 suspect frames (real resolution, via
    /// `extract_frames`, not the tiny scan buffer) for a human/Claude to look
    /// at; `None` if there were no suspects or ffmpeg/encoding failed on the
    /// sheet specifically (the numeric result above still stands either way).
    pub sheet: Option<String>,
}

fn classify(
    t_ms: u32,
    fp: &Fingerprint,
    layer_prints: &[(u32, u32, String, Vec<Fingerprint>)],
) -> (AuditSuspect, bool) {
    let mut best: Option<(&str, f32)> = None;
    let mut expected_best: Option<f32> = None;
    let mut expected_srcs = Vec::new();
    for (s, e, src, variants) in layer_prints {
        let d = min_distance(fp, variants);
        if best.map_or(true, |(_, bd)| d < bd) {
            best = Some((src, d));
        }
        if *s <= t_ms && t_ms <= *e {
            expected_srcs.push(src.clone());
            if expected_best.map_or(true, |bd| d < bd) {
                expected_best = Some(d);
            }
        }
    }
    let flagged = match expected_best {
        None => true, // nothing expected on screen, but ffmpeg produced a frame
        Some(ed) => ed > MATCH_THRESHOLD || best.is_some_and(|(_, bd)| bd + SWAP_MARGIN < ed),
    };
    let (best_src, best_dist) = match best {
        Some((s, d)) => (Some(s.to_string()), d),
        None => (None, f32::MAX),
    };
    (
        AuditSuspect { t_ms, best_match_src: best_src, best_match_dist: best_dist, expected_srcs, expected_best_dist: expected_best },
        flagged,
    )
}

/// Check one exported video against the project that (should have) produced
/// it: every 250ms, does the frame actually look like one of the image layers
/// the project says is visible there? Flags frames whose closest-matching
/// source is a DIFFERENT layer (or a currently-invisible one) — the signature
/// of handoff §11.1's content-swap bug. Video/text/shape layers aren't checked
/// (no single static source to fingerprint against) — this only vets the
/// image-layer timeline, which is where every known-bad case so far has shown
/// up. `verbose` also returns every frame's numbers (not just flagged ones)
/// for calibrating `MATCH_THRESHOLD`/`SWAP_MARGIN` against a known-bad export.
pub(crate) fn audit_export(project: &Project, path: &str, verbose: bool) -> Result<AuditReport, String> {
    let mut layer_prints: Vec<(u32, u32, String, Vec<Fingerprint>)> = Vec::new();
    for l in &project.layers {
        if l.hidden {
            continue;
        }
        if let LayerKind::Image { src, .. } = &l.kind {
            let variants = fingerprint_variants_of_file(src)?;
            layer_prints.push((l.start_ms, l.end_ms, src.clone(), variants));
        }
    }
    if layer_prints.is_empty() {
        return Ok(AuditReport { total_frames: 0, suspects: vec![], all_frames: None, sheet: None });
    }

    let frames = bulk_scan(path)?;
    let mut suspects = Vec::new();
    let mut all = Vec::new();
    for (t_ms, fp) in &frames {
        let (entry, flagged) = classify(*t_ms, fp, &layer_prints);
        if flagged {
            suspects.push(entry.clone());
        }
        if verbose {
            all.push(entry);
        }
    }

    let sheet = build_suspect_sheet(path, &suspects).ok().flatten();
    Ok(AuditReport {
        total_frames: frames.len(),
        suspects,
        all_frames: verbose.then_some(all),
        sheet,
    })
}

/// Tile up to 16 suspects (real-resolution grabs) into one 4-column JPEG, no
/// labels baked in — the caller correlates by array order against `suspects`.
fn build_suspect_sheet(path: &str, suspects: &[AuditSuspect]) -> Result<Option<String>, String> {
    if suspects.is_empty() {
        return Ok(None);
    }
    let times: Vec<u32> = suspects.iter().take(16).map(|s| s.t_ms).collect();
    let grabs = extract_frames(path, &times, 240)?;
    if grabs.is_empty() {
        return Ok(None);
    }
    const CELL_W: u32 = 240;
    const CELL_H: u32 = 427; // 9:16-ish; real frames get letterboxed into it, not stretched
    const GAP: u32 = 4;
    let cols = 4u32.min(grabs.len() as u32);
    let rows = (grabs.len() as u32).div_ceil(cols);
    let mut sheet = image::RgbImage::from_pixel(
        cols * CELL_W + (cols + 1) * GAP,
        rows * CELL_H + (rows + 1) * GAP,
        image::Rgb([20, 20, 20]),
    );
    for (i, (_, png)) in grabs.iter().enumerate() {
        let Ok(frame) = image::load_from_memory(png) else { continue };
        let fitted = frame.resize(CELL_W, CELL_H, image::imageops::FilterType::Triangle).to_rgb8();
        let col = (i as u32) % cols;
        let row = (i as u32) / cols;
        let x = GAP + col * (CELL_W + GAP) + (CELL_W - fitted.width()) / 2;
        let y = GAP + row * (CELL_H + GAP) + (CELL_H - fitted.height()) / 2;
        image::imageops::overlay(&mut sheet, &fitted, x as i64, y as i64);
    }
    let mut jpeg_bytes = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut jpeg_bytes);
    image::DynamicImage::ImageRgb8(sheet)
        .write_to(&mut cursor, image::ImageFormat::Jpeg)
        .map_err(|e| format!("encode sheet: {e}"))?;
    Ok(Some(format!("data:image/jpeg;base64,{}", STANDARD.encode(&jpeg_bytes))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_rgb(r: u8, g: u8, b: u8) -> Vec<u8> {
        std::iter::repeat_n([r, g, b], 17 * 16).flatten().collect()
    }

    #[test]
    fn identical_images_have_zero_distance() {
        let px = solid_rgb(120, 130, 140);
        let a = fingerprint_from_rgb_17x16(&px);
        let b = fingerprint_from_rgb_17x16(&px);
        assert_eq!(distance(&a, &b), 0.0);
    }

    #[test]
    fn dhash_alone_distinguishes_a_gradient_from_its_reverse() {
        let mut left_to_right = vec![0u8; 17 * 16 * 3];
        let mut right_to_left = vec![0u8; 17 * 16 * 3];
        for row in 0..16 {
            for col in 0..17usize {
                let v = (col * 15) as u8;
                let rv = ((16 - col) * 15) as u8;
                let o = (row * 17 + col) * 3;
                left_to_right[o] = v;
                left_to_right[o + 1] = v;
                left_to_right[o + 2] = v;
                right_to_left[o] = rv;
                right_to_left[o + 1] = rv;
                right_to_left[o + 2] = rv;
            }
        }
        let a = fingerprint_from_rgb_17x16(&left_to_right);
        let b = fingerprint_from_rgb_17x16(&right_to_left);
        // Every row's gradient direction flips, so every dHash bit disagrees;
        // both images have the same mean grey, so colour contributes nothing.
        assert_eq!(hamming(a.dhash, b.dhash), 256);
    }

    /// Roadmap v3.2 step 1: re-check every historical "bad" export the same way
    /// the v3 finding was made — not a permanent regression test (depends on
    /// files outside the repo), run once with
    /// `cargo test --lib analyze::tests::recheck_historical_exports -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn recheck_historical_exports() {
        let cases = [
            ("C:/Users/hsili/Desktop/Simple Effects CCT/CCT Instagram Block.sefx",
             "C:/Users/hsili/Desktop/Simple Effects CCT/CCT Instagram Block.mp4"),
            ("C:/Users/hsili/Desktop/Simple Effects CCT/CCT Instagram Block v2.sefx",
             "C:/Users/hsili/Desktop/Simple Effects CCT/CCT Instagram Block v2.mp4"),
        ];
        for (sefx, mp4) in cases {
            let json = std::fs::read_to_string(sefx).expect("read sefx");
            let project: Project = serde_json::from_str(&json).expect("parse project");
            let report = audit_export(&project, mp4, true).expect("audit_export");
            println!("=== {sefx} ===");
            println!("total_frames={}", report.total_frames);
            for s in &report.suspects {
                println!(
                    "SUSPECT t={}ms best={:?} d={:.1} expected={:?} expected_d={:?}",
                    s.t_ms, s.best_match_src, s.best_match_dist, s.expected_srcs, s.expected_best_dist
                );
            }
        }
    }

    #[test]
    fn same_luminance_structure_but_different_hue_is_still_far() {
        // Same dHash (flat, no internal gradient either way) but very
        // different colour — this is the case that broke luminance-only
        // dHash on the real known-bad export (a warm photo vs. a cool
        // graphic with similar brightness structure).
        let warm = solid_rgb(200, 120, 60);
        let cool = solid_rgb(60, 130, 210);
        let a = fingerprint_from_rgb_17x16(&warm);
        let b = fingerprint_from_rgb_17x16(&cool);
        assert_eq!(hamming(a.dhash, b.dhash), 0, "flat colour fields have no internal gradient");
        // dHash alone would call these identical; colour must be the one
        // separating them, by a wide, unambiguous margin (not tuned against
        // MATCH_THRESHOLD — that's calibrated against the real export instead).
        assert!(distance(&a, &b) > 50.0, "colour alone should separate these clearly");
    }
}
