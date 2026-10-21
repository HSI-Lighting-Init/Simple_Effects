//! Multi-image shot layout detection — groundwork for the template-extractor
//! roadmap's "not every shot is one full-frame photo" gap. Today a rebuild
//! treats every shot identically: one static photo, optionally Ken-Burnsed.
//! Real templates often show several images at once within a single shot —
//! a static photo grid/collage (e.g. a 2x2 of four photos), or stacked cards
//! where 2+ images move independently and overlap. This module detects
//! which of those a shot actually is, purely from the reference video's own
//! pixels (no user annotation), reusing `align::align_pyramidal` for the
//! motion side.
//!
//! Same split as `shots.rs`/`regions.rs`: a pure, directly-testable core
//! (`classify_layout`) over already-decoded grayscale frames, plus a thin
//! ffmpeg-backed wrapper (`detect_shot_layout`) that isn't itself unit
//! tested. Two heuristic detectors, tried in order — grid first (cheaper,
//! more specific claim: N static cells), then multi-motion (only worth
//! trying once grid has ruled itself out, and only with enough samples for
//! a trajectory to mean anything). Neither is a general layout classifier;
//! both are calibrated against this file's own synthetic fixtures, not real
//! footage yet — the threshold consts below are calibration knobs a real
//! video should retune.

use image::GrayImage;
use serde::Serialize;
use ts_rs::TS;

use super::align::{self, SimParams};

/// One recovered similarity-transform sample for a `MultiMotion` region,
/// same shape/convention as `AlignSample` in `mod.rs` (`t_ms` relative to
/// the shot's own start) minus the `solved` flag — a region's trajectory is
/// always fully populated (carried forward on an unsolved sample, same as
/// `align_shot`), so there's nothing for a caller to filter on.
#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct RegionMotionSample {
    pub t_ms: u32,
    pub scale: f32,
    pub rotation_deg: f32,
    pub tx: f32,
    pub ty: f32,
}

/// One element (photo/card) within a shot's layout: its box, in frame
/// fractions (0..1), and — for a `MultiMotion` region only — its own
/// recovered motion trajectory. Empty `motion` for a `Grid` region: those
/// are static by construction (that's what qualifies them as a grid).
#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ElementRegion {
    pub x_frac: f32,
    pub y_frac: f32,
    pub w_frac: f32,
    pub h_frac: f32,
    pub motion: Vec<RegionMotionSample>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum LayoutKind {
    Single,
    Grid,
    MultiMotion,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ShotLayout {
    pub kind: LayoutKind,
    pub regions: Vec<ElementRegion>,
}

// --- shared small helpers -------------------------------------------------

/// Mean absolute per-pixel difference between two equal-length grayscale
/// buffers.
fn mean_abs_diff(a: &[u8], b: &[u8]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    if a.is_empty() {
        return 0.0;
    }
    let sum: u64 = a.iter().zip(b.iter()).map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs() as u64).sum();
    sum as f32 / a.len() as f32
}

fn crop(frame: &GrayImage, x: u32, y: u32, w: u32, h: u32) -> GrayImage {
    image::imageops::crop_imm(frame, x, y, w.max(1), h.max(1)).to_image()
}

// --- 1. grid detection -----------------------------------------------------

/// Fraction of each cell's own width/height inset from its edges before
/// sampling — keeps a divider line (or its adjacent bleed) out of both the
/// stability and cross-cell content comparisons.
const GRID_GUTTER_FRAC: f32 = 0.03;
/// A candidate's worst (max) per-cell frame-to-frame mean abs luminance
/// delta must sit under this to call every cell "static". Calibration knob.
const GRID_STABLE_MAX: f32 = 6.0;
/// A candidate's best (min) pairwise cross-cell content dissimilarity (mean
/// abs diff of two cells' small downsamples) must clear this — if any two
/// cells look near-identical it's probably not a deliberate grid of
/// distinct photos. Calibration knob.
const GRID_DISSIM_MIN: f32 = 22.0;
const GRID_DOWNSAMPLE: u32 = 16;

struct GridCell {
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
}

fn grid_cells(cols: u32, rows: u32, w: u32, h: u32) -> Vec<GridCell> {
    let mut out = Vec::with_capacity((cols * rows) as usize);
    for r in 0..rows {
        for c in 0..cols {
            out.push(GridCell { x0: c * w / cols, x1: (c + 1) * w / cols, y0: r * h / rows, y1: (r + 1) * h / rows });
        }
    }
    out
}

/// Inset a cell's bounds by `GRID_GUTTER_FRAC` of its own width/height on
/// every edge, clamped so the result is always at least 1x1.
fn inset_bounds(x0: u32, y0: u32, x1: u32, y1: u32) -> (u32, u32, u32, u32) {
    let w = x1.saturating_sub(x0);
    let h = y1.saturating_sub(y0);
    let gx = ((w as f32 * GRID_GUTTER_FRAC) as u32).min(w / 2);
    let gy = ((h as f32 * GRID_GUTTER_FRAC) as u32).min(h / 2);
    (x0 + gx, y0 + gy, w.saturating_sub(2 * gx).max(1), h.saturating_sub(2 * gy).max(1))
}

/// A cell's content, downsampled to a small fixed size for cross-cell
/// comparison (nearest-neighbour — this is a coarse dissimilarity probe,
/// not a quality resample).
fn cell_content(frame: &GrayImage, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    let cropped = crop(frame, x, y, w, h);
    image::imageops::resize(&cropped, GRID_DOWNSAMPLE, GRID_DOWNSAMPLE, image::imageops::FilterType::Nearest).into_raw()
}

/// Tries one candidate partition (`cols` x `rows`). `None` if it doesn't
/// pass both the stability and cross-cell-dissimilarity bars.
fn try_grid_candidate(frames: &[GrayImage], cols: u32, rows: u32) -> Option<Vec<ElementRegion>> {
    let (w, h) = frames[0].dimensions();
    let cells = grid_cells(cols, rows, w, h);
    let inset: Vec<(u32, u32, u32, u32)> = cells.iter().map(|c| inset_bounds(c.x0, c.y0, c.x1, c.y1)).collect();

    let mut max_stability = 0f32;
    for &(ix, iy, iw, ih) in &inset {
        if frames.len() < 2 {
            continue;
        }
        let mut sum = 0f32;
        for pair in frames.windows(2) {
            let a = crop(&pair[0], ix, iy, iw, ih);
            let b = crop(&pair[1], ix, iy, iw, ih);
            sum += mean_abs_diff(a.as_raw(), b.as_raw());
        }
        max_stability = max_stability.max(sum / (frames.len() - 1) as f32);
    }
    if max_stability > GRID_STABLE_MAX {
        return None;
    }

    let contents: Vec<Vec<u8>> = inset.iter().map(|&(x, y, w, h)| cell_content(&frames[0], x, y, w, h)).collect();
    let mut min_dissim = f32::MAX;
    for i in 0..contents.len() {
        for j in (i + 1)..contents.len() {
            min_dissim = min_dissim.min(mean_abs_diff(&contents[i], &contents[j]));
        }
    }
    if min_dissim < GRID_DISSIM_MIN {
        return None;
    }

    Some(
        cells
            .iter()
            .map(|c| ElementRegion {
                x_frac: c.x0 as f32 / w as f32,
                y_frac: c.y0 as f32 / h as f32,
                w_frac: (c.x1 - c.x0) as f32 / w as f32,
                h_frac: (c.y1 - c.y0) as f32 / h as f32,
                motion: Vec::new(),
            })
            .collect(),
    )
}

/// Tries 2x1, 1x2, 2x2 in turn; among candidates that pass, prefers the one
/// with the most cells (the more specific claim).
fn try_grid(frames: &[GrayImage]) -> Option<Vec<ElementRegion>> {
    if frames.len() < 2 {
        return None;
    }
    let mut best: Option<Vec<ElementRegion>> = None;
    for &(cols, rows) in &[(2u32, 1u32), (1, 2), (2, 2)] {
        if let Some(regions) = try_grid_candidate(frames, cols, rows) {
            if best.as_ref().is_none_or(|b| regions.len() > b.len()) {
                best = Some(regions);
            }
        }
    }
    best
}

// --- 2. multi-motion detection ---------------------------------------------

const MULTI_MOTION_MIN_FRAMES: usize = 4;
/// Fraction of per-frame alignment calls that must solve for a region's
/// trajectory to be trusted at all.
const MULTI_MOTION_MIN_SOLVED_FRAC: f32 = 0.75;
/// A region counts as "moved" if its last sample's scale differs from
/// identity by at least this fraction...
const MULTI_MOTION_MIN_SCALE_DELTA: f32 = 0.03;
/// ...or its translation magnitude (analysis px) exceeds this.
const MULTI_MOTION_MIN_TRANSLATE_PX: f32 = 3.0;
/// Two regions' scale trajectories "disagree" once they differ by more than
/// this at any shared sample.
const DIVERGE_SCALE_TOL: f32 = 0.04;

/// Aligns every sampled frame's crop of one candidate region against that
/// region's own first-frame crop (fixed template — `classify_layout` has no
/// real "previous frame" concept, only an ordered sample list), each
/// initialized from the previous sample's result (carried forward
/// unchanged on a failed solve), same walk pattern as `align_shot` in
/// `mod.rs`. Returns the solved fraction (of the `frames.len() - 1` alignment
/// calls) plus the full per-sample trajectory (index 0 is identity by
/// construction).
fn track_region(frames: &[GrayImage], times_ms: &[u32], x: u32, y: u32, w: u32, h: u32) -> (f32, Vec<RegionMotionSample>) {
    let first = crop(&frames[0], x, y, w, h);
    let mut samples = Vec::with_capacity(frames.len());
    samples.push(RegionMotionSample { t_ms: times_ms[0], scale: 1.0, rotation_deg: 0.0, tx: 0.0, ty: 0.0 });
    let mut prev = SimParams::IDENTITY;
    let mut solved_count = 0usize;
    for i in 1..frames.len() {
        let img = crop(&frames[i], x, y, w, h);
        let solved = align::align_pyramidal(&first, &img, prev, 3);
        if solved.is_some() {
            solved_count += 1;
        }
        let p = solved.map(|f| f.params).unwrap_or(prev);
        samples.push(RegionMotionSample { t_ms: times_ms[i], scale: p.scale(), rotation_deg: p.rotation_rad().to_degrees(), tx: p.tx, ty: p.ty });
        prev = p;
    }
    let denom = (frames.len() - 1).max(1) as f32;
    (solved_count as f32 / denom, samples)
}

/// (a) reliably tracked and (b) actually displaced from identity — see the
/// module-level consts.
fn region_moved(samples: &[RegionMotionSample]) -> bool {
    let Some(last) = samples.last() else { return false };
    let scale_delta = (last.scale - 1.0).abs();
    let translate = (last.tx * last.tx + last.ty * last.ty).sqrt();
    scale_delta >= MULTI_MOTION_MIN_SCALE_DELTA || translate >= MULTI_MOTION_MIN_TRANSLATE_PX
}

/// Both trajectories start at scale 1.0 by construction, so comparing scale
/// directly (rather than a ratio-of-ratios) at each shared sample index is
/// exactly "how differently did these two zoom".
fn max_scale_divergence(a: &[RegionMotionSample], b: &[RegionMotionSample]) -> f32 {
    a.iter().zip(b.iter()).map(|(sa, sb)| (sa.scale - sb.scale).abs()).fold(0.0, f32::max)
}

fn try_multi_motion_candidate(frames: &[GrayImage], times_ms: &[u32], a: (u32, u32, u32, u32), b: (u32, u32, u32, u32)) -> Option<Vec<ElementRegion>> {
    let (solved_a, samples_a) = track_region(frames, times_ms, a.0, a.1, a.2, a.3);
    let (solved_b, samples_b) = track_region(frames, times_ms, b.0, b.1, b.2, b.3);
    if solved_a < MULTI_MOTION_MIN_SOLVED_FRAC || solved_b < MULTI_MOTION_MIN_SOLVED_FRAC {
        return None;
    }
    // Both regions must be confidently moving on their own (not just one
    // active region compared against an inert one) — a shot with one real
    // moving element and one flat/empty crop isn't this layout kind.
    if !region_moved(&samples_a) || !region_moved(&samples_b) {
        return None;
    }
    if max_scale_divergence(&samples_a, &samples_b) < DIVERGE_SCALE_TOL {
        return None;
    }
    let (w, h) = frames[0].dimensions();
    let region = |box_: (u32, u32, u32, u32), motion: Vec<RegionMotionSample>| ElementRegion {
        x_frac: box_.0 as f32 / w as f32,
        y_frac: box_.1 as f32 / h as f32,
        w_frac: box_.2 as f32 / w as f32,
        h_frac: box_.3 as f32 / h as f32,
        motion,
    };
    Some(vec![region(a, samples_a), region(b, samples_b)])
}

/// Two candidate region-pairs: left/right 60%-width (overlapping the middle
/// 20%) and top/bottom 60%-height (overlapping likewise) — deliberately
/// overlapping, since stacked/animated photo cards often do.
fn try_multi_motion(frames: &[GrayImage], times_ms: &[u32]) -> Option<Vec<ElementRegion>> {
    if frames.len() < MULTI_MOTION_MIN_FRAMES {
        return None;
    }
    let (w, h) = frames[0].dimensions();
    let rw = ((w as f32) * 0.6).round() as u32;
    let rh = ((h as f32) * 0.6).round() as u32;
    let left = (0, 0, rw, h);
    let right = (w.saturating_sub(rw), 0, rw, h);
    let top = (0, 0, w, rh);
    let bottom = (0, h.saturating_sub(rh), w, rh);
    try_multi_motion_candidate(frames, times_ms, left, right).or_else(|| try_multi_motion_candidate(frames, times_ms, top, bottom))
}

// --- entry point -------------------------------------------------------

/// `frames` are already-decoded grayscale frames, evenly spaced across a
/// shot, all the same size. `sample_times_ms` are each frame's timestamp
/// relative to the shot's own start (same convention as `AlignSample`),
/// same length as `frames`. Tries grid detection, then (only if that found
/// nothing, and there's enough samples) multi-motion detection; otherwise
/// `Single`.
fn classify_layout(frames: &[GrayImage], sample_times_ms: &[u32]) -> ShotLayout {
    if frames.is_empty() {
        return ShotLayout { kind: LayoutKind::Single, regions: Vec::new() };
    }
    if let Some(regions) = try_grid(frames) {
        return ShotLayout { kind: LayoutKind::Grid, regions };
    }
    if let Some(regions) = try_multi_motion(frames, sample_times_ms) {
        return ShotLayout { kind: LayoutKind::MultiMotion, regions };
    }
    ShotLayout { kind: LayoutKind::Single, regions: Vec::new() }
}

// --- ffmpeg wrapper (thin, not directly unit tested) ------------------------

/// Samples `K` evenly spaced timestamps across `[start_ms, end_ms]` and
/// classifies the shot's layout from the real decoded pixels — the
/// ffmpeg-backed counterpart to `classify_layout`, which carries this
/// module's actual test coverage. Reuses `analyze::extract_frames` (this
/// module is `analyze::layout`, a child of `analyze`, and `extract_frames`
/// is `pub(crate)`) rather than its own ffmpeg pass.
pub fn detect_shot_layout(path: &str, start_ms: u32, end_ms: u32, short_side: u32) -> Result<ShotLayout, String> {
    const K: u32 = 6;
    let span = end_ms.saturating_sub(start_ms);
    if span < 800 {
        return Ok(ShotLayout { kind: LayoutKind::Single, regions: Vec::new() });
    }
    let times: Vec<u32> = (0..K).map(|i| start_ms + span * i / (K - 1)).collect();
    let raw = super::extract_frames(path, &times, short_side)?;
    let mut frames = Vec::with_capacity(raw.len());
    let mut rel_times = Vec::with_capacity(raw.len());
    for (t, bytes) in raw {
        if let Ok(img) = image::load_from_memory(&bytes) {
            frames.push(img.to_luma8());
            rel_times.push(t.saturating_sub(start_ms));
        }
    }
    if frames.len() < 4 {
        return Ok(ShotLayout { kind: LayoutKind::Single, regions: Vec::new() });
    }
    Ok(classify_layout(&frames, &rel_times))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Luma};

    /// Textured (non-flat) synthetic grayscale pattern, phase-shifted by
    /// `seed` so different calls produce visually distinct textures — same
    /// idea as `align.rs`'s `test_pattern`, parameterized for cross-region
    /// distinctness.
    fn test_pattern(w: u32, h: u32, seed: f32) -> GrayImage {
        ImageBuffer::from_fn(w, h, |x, y| {
            let (fx, fy) = (x as f32, y as f32);
            let v = 128.0
                + 60.0 * ((fx / 17.0 + seed).sin() * (fy / 23.0 + seed * 1.7).cos())
                + 40.0 * (((fx - 60.0 - seed * 9.0).powi(2) + (fy - 40.0 + seed * 5.0).powi(2)) / 900.0).cos()
                + 0.15 * fx
                - 0.1 * fy;
            Luma([v.clamp(0.0, 255.0) as u8])
        })
    }

    fn sample_bilinear(img: &GrayImage, x: f32, y: f32) -> f32 {
        let (w, h) = img.dimensions();
        if x < 0.0 || y < 0.0 || x >= w as f32 - 1.0 || y >= h as f32 - 1.0 {
            return 128.0;
        }
        let (x0f, y0f) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0f, y - y0f);
        let (x0, y0) = (x0f as u32, y0f as u32);
        let g = |px: u32, py: u32| img.get_pixel(px, py)[0] as f32;
        g(x0, y0) * (1.0 - fx) * (1.0 - fy) + g(x0 + 1, y0) * fx * (1.0 - fy) + g(x0, y0 + 1) * (1.0 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy
    }

    /// Warps `src` by `truth` (about the image centre) via bilinear
    /// sampling — a local re-derivation of `align.rs`'s private
    /// `synth_target`/`SimParams::inverse`/`apply` (those are private to
    /// `align`, unreachable from a sibling module), test-only.
    fn synth_warp(src: &GrayImage, truth: SimParams) -> GrayImage {
        let (w, h) = src.dimensions();
        let d = (truth.re * truth.re + truth.im * truth.im).max(1e-12);
        let (ire, iim) = (truth.re / d, -truth.im / d);
        let (itx, ity) = (-(ire * truth.tx - iim * truth.ty), -(iim * truth.tx + ire * truth.ty));
        let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
        ImageBuffer::from_fn(w, h, |x, y| {
            let (dx, dy) = (x as f32 - cx, y as f32 - cy);
            let sx = ire * dx - iim * dy + itx + cx;
            let sy = iim * dx + ire * dy + ity + cy;
            Luma([sample_bilinear(src, sx, sy).clamp(0.0, 255.0) as u8])
        })
    }

    /// A gently-varying (not perfectly flat, so it isn't a degenerate edge
    /// case, but low-amplitude) pattern — stands in for a single coherent
    /// photo where different crops still look like "the same thing", unlike
    /// `test_pattern`'s deliberately high-amplitude, fast-varying texture
    /// (which two crops of would look almost as different from each other
    /// as two genuinely distinct photos — realistic for "does this look
    /// like a deliberate photo grid", not realistic for "is this one photo").
    fn low_variation_pattern(w: u32, h: u32) -> GrayImage {
        ImageBuffer::from_fn(w, h, |x, y| {
            let (fx, fy) = (x as f32, y as f32);
            let v = 128.0 + 6.0 * (fx / 97.0).sin() + 4.0 * (fy / 83.0).cos() + 0.04 * fx - 0.03 * fy;
            Luma([v.clamp(0.0, 255.0) as u8])
        })
    }

    const N: u32 = 6;

    fn times(n: u32) -> Vec<u32> {
        (0..n).map(|i| i * 200).collect()
    }

    #[test]
    fn uniform_shared_zoom_is_single_not_multi_motion() {
        // A real but SHARED camera zoom across the whole frame — must not
        // be misread as two independently-moving elements.
        let src = test_pattern(256, 256, 0.0);
        let frames: Vec<GrayImage> = (0..N)
            .map(|i| {
                let s = 1.0 + 0.08 * (i as f32) / (N as f32 - 1.0);
                synth_warp(&src, SimParams { re: s, im: 0.0, tx: 0.0, ty: 0.0 })
            })
            .collect();
        let layout = classify_layout(&frames, &times(N));
        assert!(layout.kind == LayoutKind::Single, "expected Single, got {:?} with {} region(s)", layout.kind, layout.regions.len());
    }

    #[test]
    fn grid_of_four_distinct_static_photos_is_detected() {
        let half = 128u32;
        let tl = test_pattern(half, half, 0.0);
        let tr = test_pattern(half, half, 3.1);
        let bl = test_pattern(half, half, 6.2);
        let br = test_pattern(half, half, 9.3);
        let frame = ImageBuffer::from_fn(256, 256, |x, y| {
            let src = match (x < half, y < half) {
                (true, true) => &tl,
                (false, true) => &tr,
                (true, false) => &bl,
                (false, false) => &br,
            };
            Luma([src.get_pixel(x % half, y % half)[0]])
        });
        let frames: Vec<GrayImage> = (0..N).map(|_| frame.clone()).collect();
        let layout = classify_layout(&frames, &times(N));
        assert!(layout.kind == LayoutKind::Grid, "expected Grid, got {:?}", layout.kind);
        assert_eq!(layout.regions.len(), 4, "expected 4 cells");
        for (ex, ey) in [(0.0f32, 0.0f32), (0.5, 0.0), (0.0, 0.5), (0.5, 0.5)] {
            let found = layout
                .regions
                .iter()
                .any(|r| (r.x_frac - ex).abs() < 0.05 && (r.y_frac - ey).abs() < 0.05 && (r.w_frac - 0.5).abs() < 0.05 && (r.h_frac - 0.5).abs() < 0.05);
            assert!(found, "no region near quadrant ({ex},{ey}): {:?}", layout.regions.iter().map(|r| (r.x_frac, r.y_frac, r.w_frac, r.h_frac)).collect::<Vec<_>>());
        }
    }

    #[test]
    fn two_independently_moving_regions_detected_as_multi_motion() {
        // Left half zooms in 1.0 -> 1.25; right half zooms out 1.0 -> 0.85
        // (the spec's "or moves the opposite direction" alternative) — both
        // regions are then independently "confidently moving", and their
        // trajectories clearly disagree.
        let half = 128u32;
        let a = test_pattern(half, 256, 0.0);
        let b = test_pattern(half, 256, 5.0);
        let frames: Vec<GrayImage> = (0..N)
            .map(|i| {
                let t = i as f32 / (N as f32 - 1.0);
                let wa = synth_warp(&a, SimParams { re: 1.0 + 0.25 * t, im: 0.0, tx: 0.0, ty: 0.0 });
                let wb = synth_warp(&b, SimParams { re: 1.0 - 0.15 * t, im: 0.0, tx: 0.0, ty: 0.0 });
                ImageBuffer::from_fn(256, 256, |x, y| if x < half { Luma([wa.get_pixel(x, y)[0]]) } else { Luma([wb.get_pixel(x - half, y)[0]]) })
            })
            .collect();
        let layout = classify_layout(&frames, &times(N));
        assert!(layout.kind == LayoutKind::MultiMotion, "expected MultiMotion, got {:?}", layout.kind);
        assert_eq!(layout.regions.len(), 2, "expected 2 regions");

        let left_region = layout.regions.iter().min_by(|r1, r2| r1.x_frac.partial_cmp(&r2.x_frac).unwrap()).unwrap();
        let right_region = layout.regions.iter().max_by(|r1, r2| r1.x_frac.partial_cmp(&r2.x_frac).unwrap()).unwrap();
        let last_left = left_region.motion.last().unwrap().scale;
        let last_right = right_region.motion.last().unwrap().scale;
        assert!((last_left - 1.25).abs() / 1.25 < 0.10, "left region scale {last_left} not close to ground truth 1.25");
        assert!((last_right - 0.85).abs() / 0.85 < 0.10, "right region scale {last_right} not close to ground truth 0.85");
    }

    #[test]
    fn single_static_unchanging_frame_is_single() {
        // One coherent texture, no divisions, byte-identical every frame —
        // negative test against both a grid false-positive (nothing
        // dissimilar enough to call a deliberate grid of distinct photos)
        // and a multi-motion false-positive (nothing moved at all).
        let frame = low_variation_pattern(256, 256);
        let frames: Vec<GrayImage> = (0..N).map(|_| frame.clone()).collect();
        let layout = classify_layout(&frames, &times(N));
        assert!(layout.kind == LayoutKind::Single, "expected Single, got {:?} with {} region(s)", layout.kind, layout.regions.len());
    }
}
