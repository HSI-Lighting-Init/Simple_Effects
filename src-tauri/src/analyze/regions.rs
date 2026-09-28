//! Text/graphic overlay region detection — groundwork for the template-
//! extractor roadmap's text/graphics pass. This finds WHERE (a rough
//! comp-fraction bounding box, grid-snapped) and WHEN (a start/end within
//! the shot) something looking like a title/lower-third/badge was overlaid
//! on top of moving footage. It is NOT OCR, NOT font matching, and NOT
//! pixel-precise — a heuristic contrast signal only, meant to hand a human
//! or a downstream AI step a short list of "look here" candidates, each
//! with a confidence to filter by. Expect false negatives (a subtle
//! animated title that never holds still long enough) and occasional false
//! positives (a genuinely static patch of footage, like a plain sky) —
//! that's the known ceiling of a frame-difference-only approach; a real
//! text/graphics detector would need actual content classification.
//!
//! Signal exploited: a text/graphic overlay typically appears partway
//! through a shot, then stays spatially STABLE (same pixels, maybe with a
//! subtle animation) while the REST of the frame keeps changing underneath
//! it. So a region only qualifies while it is anomalously static RELATIVE
//! to a whole frame that is itself clearly still active — never because the
//! whole shot happens to be a still frame (see `FRAME_ACTIVITY_MIN` below,
//! and the "fully static shot" test).

use std::collections::HashMap;

use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TextRegion {
    /// Relative to the shot's own start — the caller adds the shot's
    /// absolute `start_ms`.
    pub start_ms: u32,
    pub end_ms: u32,
    pub x_frac: f32,
    pub y_frac: f32,
    pub w_frac: f32,
    pub h_frac: f32,
    /// 0..1, relative confidence only (not a calibrated probability) — low
    /// enough to be a plain footage patch that happened to hold still for a
    /// few frames, high enough to be a strong candidate. Callers should
    /// filter, not trust blindly.
    pub confidence: f32,
}

/// Consecutive qualifying transitions a cell needs before it counts as
/// "stable" — filters single-frame noise / a coincidental one-off match
/// between two frames rather than a genuine hold.
const MIN_RUN: usize = 3;

/// Below this whole-frame mean abs-luminance delta, the frame isn't
/// "clearly still changing" at all — there's no moving-frame-vs-stable-
/// region contrast to exploit, so nothing can qualify (this is what keeps
/// an entirely static shot from being flagged as one giant region).
const FRAME_ACTIVITY_MIN: f32 = 3.0;
/// Absolute noise floor a cell's own delta must sit under to be "stable".
const STABLE_CELL_MAX: f32 = 2.0;
/// A cell must also be at most this fraction of the frame's own delta at
/// that instant — an absolute-only floor would call a cell "stable" during
/// a generally quiet (but not overlay-quiet) moment; this keeps the
/// comparison relative to how active the rest of the frame is right now.
const STABLE_RATIO: f32 = 0.35;

struct CellRun {
    cell: usize,
    // Inclusive transition-sample indices (a transition `t` is the
    // frame[t] -> frame[t+1] step).
    start_t: usize,
    end_t: usize,
}

fn find(parent: &mut [usize], x: usize) -> usize {
    let mut root = x;
    while parent[root] != root {
        root = parent[root];
    }
    let mut cur = x;
    while parent[cur] != root {
        let next = parent[cur];
        parent[cur] = root;
        cur = next;
    }
    root
}

fn union(parent: &mut [usize], a: usize, b: usize) {
    let (ra, rb) = (find(parent, a), find(parent, b));
    if ra != rb {
        parent[ra] = rb;
    }
}

/// Best-effort, heuristic overlay-region detection within a single shot.
/// `frames` must be evenly spaced, same width*height grayscale buffers, in
/// time order (`t_ms` relative to the shot's own start). `grid_cols` /
/// `grid_rows` divide the frame into a coarse grid for candidate-region
/// purposes — this deliberately snaps to that grid rather than hunting for
/// pixel-precise boxes (a title's stable pixels rarely line up on a cell
/// boundary anyway; that precision wouldn't be trustworthy from this signal).
pub fn detect_text_regions(frames: &[(u32, Vec<u8>)], width: u32, height: u32, grid_cols: u32, grid_rows: u32) -> Vec<TextRegion> {
    let n = frames.len();
    if n < MIN_RUN + 1 || grid_cols == 0 || grid_rows == 0 || width == 0 || height == 0 {
        return Vec::new();
    }
    let (w, h) = (width as usize, height as usize);
    let (cols, rows) = (grid_cols as usize, grid_rows as usize);
    let n_cells = cols * rows;
    let n_trans = n - 1;

    let cell_bounds = |c: usize| -> (usize, usize, usize, usize) {
        let (cx, cy) = (c % cols, c / cols);
        (cx * w / cols, (cx + 1) * w / cols, cy * h / rows, (cy + 1) * h / rows)
    };

    // cell_scores[c][t] / frame_scores[t]: mean abs luminance delta between
    // frame[t] and frame[t+1], restricted to cell `c`'s pixels (or the whole
    // frame). Cells exactly partition the frame, so summing every cell's sum
    // gives the whole-frame sum too — no second pass needed.
    let mut cell_scores = vec![vec![0f32; n_trans]; n_cells];
    let mut frame_scores = vec![0f32; n_trans];
    for t in 0..n_trans {
        let (prev, cur) = (&frames[t].1, &frames[t + 1].1);
        let mut frame_sum = 0f64;
        for c in 0..n_cells {
            let (x0, x1, y0, y1) = cell_bounds(c);
            let mut sum = 0f64;
            let mut count = 0usize;
            for y in y0..y1 {
                let row = y * w;
                for x in x0..x1 {
                    let d = (prev[row + x] as i32 - cur[row + x] as i32).unsigned_abs() as f64;
                    sum += d;
                    count += 1;
                }
            }
            cell_scores[c][t] = if count > 0 { (sum / count as f64) as f32 } else { 0.0 };
            frame_sum += sum;
        }
        frame_scores[t] = (frame_sum / (w * h) as f64) as f32;
    }

    // Per cell: maximal runs of consecutive qualifying transitions, kept
    // only once they reach MIN_RUN (a single quiet frame is noise, not a
    // held title).
    let mut runs: Vec<CellRun> = Vec::new();
    for c in 0..n_cells {
        let mut run_start: Option<usize> = None;
        for t in 0..n_trans {
            let qualifies = frame_scores[t] >= FRAME_ACTIVITY_MIN
                && cell_scores[c][t] <= STABLE_CELL_MAX
                && cell_scores[c][t] <= frame_scores[t] * STABLE_RATIO;
            if qualifies {
                run_start.get_or_insert(t);
            } else if let Some(s) = run_start.take() {
                if t - s >= MIN_RUN {
                    runs.push(CellRun { cell: c, start_t: s, end_t: t - 1 });
                }
            }
        }
        if let Some(s) = run_start {
            if n_trans - s >= MIN_RUN {
                runs.push(CellRun { cell: c, start_t: s, end_t: n_trans - 1 });
            }
        }
    }
    if runs.is_empty() {
        return Vec::new();
    }

    // Merge 4-connected cells whose stable runs overlap in time into one
    // region per connected component.
    // ponytail: O(runs²) pairwise adjacency check — fine at grid-cell scale
    // (tens of runs); revisit with a spatial/time index if grid_cols*rows
    // grows a lot.
    let mut parent: Vec<usize> = (0..runs.len()).collect();
    for i in 0..runs.len() {
        for j in (i + 1)..runs.len() {
            let (ci, cj) = (runs[i].cell, runs[j].cell);
            let (cxi, cyi) = (ci % cols, ci / cols);
            let (cxj, cyj) = (cj % cols, cj / cols);
            let adjacent = (cxi == cxj && cyi.abs_diff(cyj) == 1) || (cyi == cyj && cxi.abs_diff(cxj) == 1);
            if !adjacent {
                continue;
            }
            let overlap = runs[i].start_t <= runs[j].end_t && runs[j].start_t <= runs[i].end_t;
            if overlap {
                union(&mut parent, i, j);
            }
        }
    }

    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..runs.len() {
        groups.entry(find(&mut parent, i)).or_default().push(i);
    }

    let mut regions: Vec<TextRegion> = groups
        .into_values()
        .map(|idxs| {
            let (mut min_col, mut max_col) = (cols, 0usize);
            let (mut min_row, mut max_row) = (rows, 0usize);
            let (mut min_t, mut max_t) = (n_trans, 0usize);
            let (mut margin_sum, mut margin_n) = (0f64, 0usize);
            for &i in &idxs {
                let run = &runs[i];
                let (cx, cy) = (run.cell % cols, run.cell / cols);
                min_col = min_col.min(cx);
                max_col = max_col.max(cx);
                min_row = min_row.min(cy);
                max_row = max_row.max(cy);
                min_t = min_t.min(run.start_t);
                max_t = max_t.max(run.end_t);
                for t in run.start_t..=run.end_t {
                    let fs = frame_scores[t].max(1e-3);
                    margin_sum += (1.0 - (cell_scores[run.cell][t] / fs) as f64).max(0.0);
                    margin_n += 1;
                }
            }
            // Confidence: monotonic in how much lower the cell's variance is
            // than the frame's (averaged over the run — a bigger contrast
            // margin is a stronger "something's deliberately holding still
            // here" signal) and in how long the run held (a hold of a couple
            // seconds is much more title-like than the minimum 3 samples).
            // Both terms are 0..1 and equally weighted; documented, not
            // otherwise calibrated against real footage yet.
            let ratio_factor = if margin_n > 0 { (margin_sum / margin_n as f64) as f32 } else { 0.0 };
            let run_len = (max_t - min_t + 1) as f32;
            let length_factor = (run_len / (run_len + 6.0)).clamp(0.0, 1.0);
            let confidence = (0.5 * ratio_factor + 0.5 * length_factor).clamp(0.0, 1.0);
            TextRegion {
                start_ms: frames[min_t].0,
                end_ms: frames[max_t + 1].0,
                x_frac: min_col as f32 / cols as f32,
                y_frac: min_row as f32 / rows as f32,
                w_frac: (max_col - min_col + 1) as f32 / cols as f32,
                h_frac: (max_row - min_row + 1) as f32 / rows as f32,
                confidence,
            }
        })
        .collect();
    regions.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then(a.x_frac.partial_cmp(&b.x_frac).unwrap_or(std::cmp::Ordering::Equal)));
    regions
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic, uncorrelated-enough pseudo-noise (no rand dependency
    /// available to this module) — a small integer hash, not a real PRNG,
    /// but "changes a lot frame to frame" is all these tests need.
    fn hash_u32(mut x: u32) -> u32 {
        x ^= x >> 16;
        x = x.wrapping_mul(0x7feb352d);
        x ^= x >> 15;
        x = x.wrapping_mul(0x846ca68b);
        x ^= x >> 16;
        x
    }

    /// Per-frame noise byte: differs every frame at every pixel.
    fn noise_byte(frame: u32, x: u32, y: u32) -> u8 {
        hash_u32(frame.wrapping_mul(73_856_093) ^ x.wrapping_mul(19_349_663) ^ y.wrapping_mul(83_492_791)) as u8
    }

    /// Fixed-pattern byte: same value for every frame, varies over (x, y) —
    /// simulates a title graphic's own (non-flat, so it isn't trivially
    /// "quiet" for the wrong reason) but frame-invariant pixels.
    fn fixed_byte(x: u32, y: u32) -> u8 {
        hash_u32(x.wrapping_mul(19_349_663) ^ y.wrapping_mul(83_492_791) ^ 0xABCD_1234) as u8
    }

    const W: u32 = 60;
    const H: u32 = 80;
    const COLS: u32 = 6;
    const ROWS: u32 = 8;

    /// Builds `n` frames of a W x H buffer that's per-pixel random noise
    /// everywhere EXCEPT inside the given cell-space rectangle
    /// [col0,col1] x [row0,row1] (inclusive), which instead uses
    /// `fixed_byte` for every frame index >= `stable_from_frame` (and noise
    /// before that, so it isn't trivially quiet the whole time).
    fn frames_with_stable_rect(n: u32, col0: u32, col1: u32, row0: u32, row1: u32, stable_from_frame: u32) -> Vec<(u32, Vec<u8>)> {
        let (x0, x1) = (col0 * W / COLS, (col1 + 1) * W / COLS);
        let (y0, y1) = (row0 * H / ROWS, (row1 + 1) * H / ROWS);
        (0..n)
            .map(|f| {
                let mut buf = vec![0u8; (W * H) as usize];
                for y in 0..H {
                    for x in 0..W {
                        let in_rect = x >= x0 && x < x1 && y >= y0 && y < y1;
                        buf[(y * W + x) as usize] = if in_rect && f >= stable_from_frame { fixed_byte(x, y) } else { noise_byte(f, x, y) };
                    }
                }
                (f * 100, buf)
            })
            .collect()
    }

    #[test]
    fn finds_a_title_that_holds_still_while_the_rest_of_the_frame_keeps_moving() {
        let frames = frames_with_stable_rect(10, 1, 2, 3, 4, 3);
        let regions = detect_text_regions(&frames, W, H, COLS, ROWS);
        assert!(!regions.is_empty(), "expected at least one region");
        let r = regions.iter().find(|r| r.x_frac <= 1.0 / 6.0 + 1e-4 && r.y_frac <= 3.0 / 8.0 + 1e-4).expect("region overlapping the stable rectangle");
        // Overlaps the true rectangle [1..=2]/6 x [3..=4]/8.
        assert!(r.x_frac < 3.0 / 6.0 && r.x_frac + r.w_frac > 1.0 / 6.0, "x range {:?} doesn't overlap", (r.x_frac, r.w_frac));
        assert!(r.y_frac < 5.0 / 8.0 && r.y_frac + r.h_frac > 3.0 / 8.0, "y range {:?} doesn't overlap", (r.y_frac, r.h_frac));
        // start_ms roughly matches frame 3's time (300ms).
        assert!(r.start_ms.abs_diff(300) <= 200, "start_ms {} not close to 300", r.start_ms);
        // Doesn't spill out to cover the whole frame.
        assert!(r.w_frac * r.h_frac < 0.5, "region too large: {} x {}", r.w_frac, r.h_frac);
        assert!(r.confidence > 0.0);
    }

    #[test]
    fn a_fully_static_shot_is_not_flagged_as_one_giant_region() {
        // Every frame byte-identical everywhere — no "rest of the frame is
        // still moving" contrast to exploit at all.
        let mut buf = vec![0u8; (W * H) as usize];
        for y in 0..H {
            for x in 0..W {
                buf[(y * W + x) as usize] = fixed_byte(x, y);
            }
        }
        let frames: Vec<(u32, Vec<u8>)> = (0..10).map(|f| (f * 100, buf.clone())).collect();
        let regions = detect_text_regions(&frames, W, H, COLS, ROWS);
        for r in &regions {
            assert!(r.w_frac * r.h_frac < 0.5, "flagged a near-whole-frame region on a static shot: {} x {}", r.w_frac, r.h_frac);
        }
    }

    #[test]
    fn a_fully_chaotic_shot_reports_no_regions() {
        // Every cell changes every frame — no stable region anywhere.
        let frames: Vec<(u32, Vec<u8>)> = (0..10)
            .map(|f| {
                let buf: Vec<u8> = (0..H).flat_map(|y| (0..W).map(move |x| noise_byte(f, x, y))).collect();
                (f * 100, buf)
            })
            .collect();
        let regions = detect_text_regions(&frames, W, H, COLS, ROWS);
        assert!(regions.is_empty(), "expected no regions in a fully chaotic shot, got {:?}", regions.iter().map(|r| (r.x_frac, r.y_frac, r.confidence)).collect::<Vec<_>>());
    }

    #[test]
    fn two_independent_stable_regions_at_different_times_are_found_separately() {
        let n = 12u32;
        let (x0, x1) = (0 * W / COLS, 1 * W / COLS);
        let (y0, y1) = (0 * H / ROWS, 1 * H / ROWS);
        let (x2, x3) = (4 * W / COLS, 6 * W / COLS);
        let (y2, y3) = (6 * H / ROWS, 8 * H / ROWS);
        let frames: Vec<(u32, Vec<u8>)> = (0..n)
            .map(|f| {
                let mut buf = vec![0u8; (W * H) as usize];
                for y in 0..H {
                    for x in 0..W {
                        let in_a = x >= x0 && x < x1 && y >= y0 && y < y1;
                        let in_b = x >= x2 && x < x3 && y >= y2 && y < y3;
                        let stable = (in_a && f >= 2) || (in_b && f >= 6);
                        buf[(y * W + x) as usize] = if stable { fixed_byte(x, y) } else { noise_byte(f, x, y) };
                    }
                }
                (f * 100, buf)
            })
            .collect();
        let regions = detect_text_regions(&frames, W, H, COLS, ROWS);
        assert_eq!(regions.len(), 2, "expected two separate regions, got {:?}", regions.iter().map(|r| (r.x_frac, r.y_frac, r.start_ms)).collect::<Vec<_>>());
        let near_a = regions.iter().find(|r| r.x_frac < 0.2 && r.y_frac < 0.2).expect("region A found");
        let near_b = regions.iter().find(|r| r.x_frac > 0.5 && r.y_frac > 0.5).expect("region B found");
        assert!(near_a.start_ms.abs_diff(200) <= 200, "region A start_ms {} not close to 200", near_a.start_ms);
        assert!(near_b.start_ms.abs_diff(600) <= 200, "region B start_ms {} not close to 600", near_b.start_ms);
    }
}
