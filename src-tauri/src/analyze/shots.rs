//! Phase 2.2: shot/cut segmentation. A pure frame-difference scorer over a
//! streamed low-res decode, then a pure classifier (`segment_cuts`) that
//! turns the score curve into hard cuts (an instant jump) and soft cuts (a
//! sustained elevated-difference window — a crossfade/wipe/etc). Calibrated
//! empirically against a synthetic reference with known cut times (see the
//! `#[ignore]`d recheck-style test at the bottom), not guessed.

use std::io::Read;
use std::process::Stdio;

use serde::Serialize;
use ts_rs::TS;

use crate::{find_ffmpeg, quiet_command};

/// One frame-to-frame difference sample: mean absolute luminance delta
/// between this frame and the previous one, normalized 0..1.
fn frame_diff_scores(path: &str, fps: f32, short_side: u32) -> Result<Vec<(u32, f32)>, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found — install it to use shot detection")?;
    let vf = format!("fps={fps},scale={short_side}:-2");
    let mut child = quiet_command(&ffmpeg)
        .args(["-i", path, "-vf", &vf, "-f", "rawvideo", "-pix_fmt", "gray", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no ffmpeg stdout")?;
    let mut buf = Vec::new();
    stdout.read_to_end(&mut buf).map_err(|e| format!("read ffmpeg output: {e}"))?;
    let _ = child.wait();

    // Width isn't known up front (scale=W:-2 rounds height to even) — probe
    // it via ffprobe once rather than parsing ffmpeg's stderr.
    let probe = quiet_command(&ffmpeg)
        .args(["-i", path, "-vf", &vf, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("ffmpeg probe: {e}"))?;
    let frame_pixels = probe.stdout.len();
    if frame_pixels == 0 {
        return Err("couldn't determine frame size".into());
    }

    let frame_ms = 1000.0 / fps;
    let mut out = Vec::with_capacity(buf.len() / frame_pixels);
    let mut prev: Option<&[u8]> = None;
    for (i, frame) in buf.chunks_exact(frame_pixels).enumerate() {
        let t_ms = (i as f32 * frame_ms).round() as u32;
        let score = match prev {
            None => 0.0,
            Some(p) => {
                let sum: u64 = p.iter().zip(frame.iter()).map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs() as u64).sum();
                (sum as f64 / frame_pixels as f64 / 255.0) as f32
            }
        };
        out.push((t_ms, score));
        prev = Some(frame);
    }
    Ok(out)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum CutKind {
    Hard,
    Soft,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Cut {
    pub t_ms: u32,
    pub kind: CutKind,
    /// For a soft cut, roughly how long the elevated-difference window was.
    pub span_ms: u32,
}

/// Calibration knobs (see the module doc) — tuned against a synthetic
/// reference with known cut times, not guessed.
/// ponytail: one pass of empirical tuning; revisit against more references
/// (especially real, re-encoded reels) if it starts missing real cuts or
/// flagging mid-shot motion.
pub struct CutParams {
    pub hard: f32,
    pub soft: f32,
    pub soft_sum: f32,
    pub min_gap_ms: u32,
}

impl Default for CutParams {
    fn default() -> Self {
        // Calibrated against synthetic-1.mp4's frame-diff curve: real cuts
        // peak at 0.09-0.51, within-shot Ken Burns motion tops out ~0.046 —
        // 0.08 sits cleanly between them. `soft` (0.03) is only used to size
        // a peak's neighbourhood for the hard/soft classification, not to
        // qualify a cut by itself.
        CutParams { hard: 0.08, soft: 0.03, soft_sum: 0.05, min_gap_ms: 400 }
    }
}

/// Pure classifier: turn a difference-score curve into cuts. Finds every
/// LOCAL MAXIMUM at/above `hard` (not just the strongest one in a region) —
/// two real cuts close enough together that the signal never fully settles
/// between them (a rapid flash-cut pair) still show up as two distinct
/// peaks, which a single-threshold "region" scan would merge into one and
/// silently drop a shot. Each peak's neighbourhood (consecutive samples
/// at/above `soft`) sizes it: a lone spike is a Hard cut, a wider elevated
/// neighbourhood (>=2 extra samples either side) is a Soft one — a
/// crossfade/wipe/etc rather than an instant jump. Peaks within `min_gap_ms`
/// of each other merge (keep the stronger).
pub fn segment_cuts(scores: &[(u32, f32)], p: &CutParams) -> Vec<Cut> {
    let mut cuts: Vec<Cut> = Vec::new();
    for i in 1..scores.len() {
        let s = scores[i].1;
        if s < p.hard {
            continue;
        }
        let left = if i > 0 { scores[i - 1].1 } else { f32::MIN };
        let right = if i + 1 < scores.len() { scores[i + 1].1 } else { f32::MIN };
        if s < left || s < right {
            continue; // not a local maximum
        }
        let mut lo = i;
        while lo > 0 && scores[lo - 1].1 >= p.soft {
            lo -= 1;
        }
        let mut hi = i;
        while hi + 1 < scores.len() && scores[hi + 1].1 >= p.soft {
            hi += 1;
        }
        let span_ms = scores[hi].0 - scores[lo].0;
        let kind = if hi - lo >= 2 { CutKind::Soft } else { CutKind::Hard };
        cuts.push(Cut { t_ms: scores[i].0, kind, span_ms });
    }
    // Merge peaks within min_gap_ms, keeping the stronger (wider-span) one.
    cuts.sort_by_key(|c| c.t_ms);
    let mut merged: Vec<Cut> = Vec::new();
    for c in cuts {
        if let Some(last) = merged.last_mut() {
            if c.t_ms.abs_diff(last.t_ms) < p.min_gap_ms {
                if c.span_ms > last.span_ms {
                    *last = c;
                }
                continue;
            }
        }
        merged.push(c);
    }
    merged
}

pub(crate) fn detect_cuts(path: &str, fps: f32, short_side: u32, params: &CutParams) -> Result<Vec<Cut>, String> {
    let scores = frame_diff_scores(path, fps, short_side)?;
    Ok(segment_cuts(&scores, params))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_quiet_signal_has_no_cuts() {
        let scores: Vec<(u32, f32)> = (0..40).map(|i| (i * 100, 0.002)).collect();
        let cuts = segment_cuts(&scores, &CutParams::default());
        assert!(cuts.is_empty());
    }

    #[test]
    fn a_single_spike_is_a_hard_cut() {
        let mut scores: Vec<(u32, f32)> = (0..40).map(|i| (i * 100, 0.002)).collect();
        scores[20].1 = 0.2;
        let cuts = segment_cuts(&scores, &CutParams::default());
        assert_eq!(cuts.len(), 1);
        assert_eq!(cuts[0].kind, CutKind::Hard);
        assert_eq!(cuts[0].t_ms, 2000);
    }

    #[test]
    fn a_sustained_ramp_is_a_soft_cut_not_several_hard_ones() {
        let mut scores: Vec<(u32, f32)> = (0..40).map(|i| (i * 100, 0.002)).collect();
        for (k, v) in [(18, 0.04), (19, 0.06), (20, 0.15), (21, 0.05)] {
            scores[k].1 = v;
        }
        let cuts = segment_cuts(&scores, &CutParams::default());
        assert_eq!(cuts.len(), 1, "expected one soft cut, got {:?}", cuts);
        assert_eq!(cuts[0].kind, CutKind::Soft);
    }

    #[test]
    fn nearby_cuts_merge() {
        let mut scores: Vec<(u32, f32)> = (0..40).map(|i| (i * 100, 0.002)).collect();
        scores[20].1 = 0.2;
        scores[21].1 = 0.18; // 100ms later, under min_gap_ms — same cut
        let cuts = segment_cuts(&scores, &CutParams::default());
        assert_eq!(cuts.len(), 1, "expected the two nearby spikes to merge, got {:?}", cuts);
    }

    /// Roadmap v3.2-style empirical check: run against the same synthetic
    /// reference used for the aligner, whose true cuts are known from its
    /// own generation (Phase 1.2's `make_synthetic_reference`). Not a normal
    /// regression test (depends on a file outside the repo) — run once with
    /// `cargo test --lib analyze::shots::tests::recheck_against_synthetic_1 -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn recheck_against_synthetic_1() {
        let path = "C:/Users/hsili/Desktop/SE-test-assets/synthetic/synthetic-1.mp4";
        let cuts = detect_cuts(path, 8.0, 128, &CutParams::default()).expect("detect_cuts");
        for c in &cuts {
            println!("{}ms {:?} span={}ms", c.t_ms, c.kind, c.span_ms);
        }
        // True boundaries (from synthetic-1.truth.json): 2732(hard),
        // 3341(hard), 5734(soft ~pageTurn), 9670(hard), 13562(soft ~checkerboard).
    }
}
