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

pub(crate) mod align;
pub(crate) mod fit;
pub(crate) mod layout;
pub(crate) mod look;
pub(crate) mod regions;
pub(crate) mod shots;

use align::SimParams;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
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

/// One recovered similarity-transform sample from `align_shot`, comp-agnostic
/// (analysis-resolution scale/rotation/translation — see `align_shot`'s doc
/// for how to compose these onto the reference frame's own absolute
/// transform).
#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AlignSample {
    /// Shot-relative (0 at the shot's own `start_ms`) in every externally-
    /// visible use of this struct (the `align_reference` command, `analyze_
    /// reference`'s `ShotAnalysis.motion`) — `align_shot` itself internally
    /// works in absolute video time and each of those callers converts
    /// before handing samples out, so nothing outside this module ever sees
    /// absolute time here. Keep it that way: a caller that mixed the two
    /// once fed `fit_background` absolute times against a relative span and
    /// silently corrupted an entire scoring run (docs/STATUS-phase2-fitter-
    /// scoring.md) — the bug wasn't obvious from the data alone.
    pub t_ms: u32,
    pub scale: f32,
    pub rotation_deg: f32,
    pub tx: f32,
    pub ty: f32,
    /// True for the reference frame itself (always identity by construction)
    /// and for any timestamp the aligner couldn't solve (too little texture,
    /// too little valid overlap) — the sample is then carried over from its
    /// nearest solved neighbour rather than omitted, so callers always get
    /// one sample per requested timestamp; check this before trusting a row.
    pub solved: bool,
}

/// Gate A's harness: sample a shot at `sample_every_ms`, align every sample
/// against the frame at `ref_ms` via pyramidal IC-LK (`align::align_pyramidal`),
/// each initialized from its nearest already-solved neighbour (walking
/// outward from the reference) rather than identity — matching 2.4's "per
/// frame ... initialized from the previous frame". Frames are decoded at
/// `short_side` px (256, per 2.1) and converted to grayscale.
///
/// The returned scale/rotation/tx/ty describe each frame's transform
/// RELATIVE TO the reference frame, in analysis-pixel units. To get this
/// engine's absolute `transform.scale/x/y/rotation` at time t: pick the
/// reference frame's own absolute values (known ground truth when testing
/// against a synthetic reference; from `fit_scale`-style source-image math
/// once there's no ground truth to anchor on), then
/// `scale(t) = ref_scale * sample.scale`,
/// `rotation(t) = ref_rotation + sample.rotationDeg`,
/// `x(t) = ref_x + k * sample.tx`, `y(t) = ref_y + k * sample.ty`, where `k =
/// comp_width / analysis_width` (translation is in analysis pixels; scale and
/// rotation aren't resolution-dependent). This composition step is exactly
/// the "up to anchor/centre bookkeeping" the roadmap flags for 2.4 — kept
/// here as a doc, not code, until something other than a synthetic-reference
/// test needs to anchor without ground truth.
pub(crate) fn align_shot(path: &str, start_ms: u32, end_ms: u32, ref_ms: u32, sample_every_ms: u32, short_side: u32) -> Result<Vec<AlignSample>, String> {
    let step = sample_every_ms.max(1);
    let mut times: Vec<u32> = (start_ms..=end_ms).step_by(step as usize).collect();
    if !times.contains(&ref_ms) {
        times.push(ref_ms);
        times.sort_unstable();
    }
    let frames = extract_frames(path, &times, short_side)?;
    if frames.len() < 2 {
        return Err(format!("only {} of {} requested frames decoded — check the timestamps are inside the video", frames.len(), times.len()));
    }
    let decoded: Vec<(u32, image::GrayImage)> = frames
        .into_iter()
        .filter_map(|(t, bytes)| image::load_from_memory(&bytes).ok().map(|im| (t, im.to_luma8())))
        .collect();
    let ref_idx = decoded
        .iter()
        .enumerate()
        .min_by_key(|(_, (t, _))| t.abs_diff(ref_ms))
        .map(|(i, _)| i)
        .ok_or("no frames decoded")?;
    let reference = &decoded[ref_idx].1;

    let mut out = vec![AlignSample { t_ms: 0, scale: 0.0, rotation_deg: 0.0, tx: 0.0, ty: 0.0, solved: false }; decoded.len()];
    out[ref_idx] = AlignSample { t_ms: decoded[ref_idx].0, scale: 1.0, rotation_deg: 0.0, tx: 0.0, ty: 0.0, solved: true };

    // Background motion only — an element layer (Phase 3) may legitimately
    // spin further than a shot's own background ever should.
    const MAX_ROTATION_DEG: f32 = 45.0;

    let mut walk = |range: Box<dyn Iterator<Item = usize>>| {
        let mut prev = SimParams::IDENTITY;
        for i in range {
            let (t, frame) = &decoded[i];
            // Previous-frame init converges faster and tracks smooth motion
            // well, but once ONE frame fails, every frame after it was
            // inheriting the SAME stale `prev` forever — a cascading
            // failure (found live: solve rate falls from 84% near the
            // reference frame to near 0% past 12s, docs/STATUS-phase2-
            // fitter-scoring.md). Race BOTH a prev-seeded and an
            // identity-seeded attempt against the ORIGINAL reference frame
            // and keep whichever fits better (lower residual) — a second
            // attempt from identity gives every frame an independent chance
            // to recover, rather than being permanently stuck behind one bad
            // estimate.
            let from_prev = align::align_pyramidal(reference, frame, prev, 4);
            let from_identity = align::align_pyramidal(reference, frame, SimParams::IDENTITY, 4);
            let best = match (from_prev, from_identity) {
                (Some(a), Some(b)) => Some(if a.residual <= b.residual { a } else { b }),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            };
            // The race above only asks "which fits better" — a numerically
            // converged but degenerate warp (scale collapsing toward 0, or a
            // residual that never actually shrank) can still win that race
            // against an equally-bad alternative. Gate the winner itself
            // before trusting it (found live: `align_pyramidal` returning
            // `Some` for exactly this, still read as `solved: true` by every
            // caller, docs/STATUS-phase2-fitter-scoring.md).
            let solved = best.filter(|f| align::plausible(f, MAX_ROTATION_DEG));
            let p = solved.map(|f| f.params).unwrap_or(prev);
            out[i] = AlignSample { t_ms: *t, scale: p.scale(), rotation_deg: p.rotation_rad().to_degrees(), tx: p.tx, ty: p.ty, solved: solved.is_some() };
            prev = p; // carry the last estimate forward even on failure — still closer than identity
        }
    };
    walk(Box::new((0..ref_idx).rev()));
    walk(Box::new((ref_idx + 1)..decoded.len()));

    Ok(out)
}

/// 2.5: `align_shot`'s dense per-frame samples, keyed down to a small
/// editor-style set of `Keyframe`s per channel — see `fit::fit_channels`'s
/// doc for the algorithm. Still in `align_shot`'s relative, analysis-pixel
/// space (not this engine's absolute comp-space transform) — the same
/// anchor/centre composition `align_shot`'s own doc describes applies to
/// these keyframes' VALUES before they land in a real `Transform`; only the
/// shaping (times + easing) happens here.
#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct FittedMotion {
    pub scale: Vec<crate::model::Keyframe>,
    pub rotation_deg: Vec<crate::model::Keyframe>,
    pub tx: Vec<crate::model::Keyframe>,
    pub ty: Vec<crate::model::Keyframe>,
}

pub(crate) fn fit_background(samples: &[AlignSample], span_start_ms: u32, span_end_ms: u32) -> FittedMotion {
    // `solved: false` rows are carried-forward placeholders (align_shot's
    // doc), not real measurements — fitting a curve through them alongside
    // real samples reads a frozen placeholder run as if it were genuine
    // flat motion, and can badly mislead the shape search right where the
    // aligner actually lost track. Fall back to the raw list only if
    // filtering would leave nothing to fit.
    let solved: Vec<&AlignSample> = samples.iter().filter(|s| s.solved).collect();
    let samples: Vec<&AlignSample> = if solved.is_empty() { samples.iter().collect() } else { solved };

    let times: Vec<u32> = samples.iter().map(|s| s.t_ms).collect();
    let scale: Vec<f32> = samples.iter().map(|s| s.scale).collect();
    let rotation: Vec<f32> = samples.iter().map(|s| s.rotation_deg).collect();
    let tx: Vec<f32> = samples.iter().map(|s| s.tx).collect();
    let ty: Vec<f32> = samples.iter().map(|s| s.ty).collect();
    let channels = [
        fit::Channel { name: "scale", values: &scale },
        fit::Channel { name: "rotationDeg", values: &rotation },
        fit::Channel { name: "tx", values: &tx },
        fit::Channel { name: "ty", values: &ty },
    ];
    let mut fitted = fit::fit_channels(&times, &channels, (span_start_ms, span_end_ms), &[], &fit::FitParams::default());
    let ty_keys = fitted.pop().unwrap();
    let tx_keys = fitted.pop().unwrap();
    let rot_keys = fitted.pop().unwrap();
    let scale_keys = fitted.pop().unwrap();
    FittedMotion { scale: scale_keys, rotation_deg: rot_keys, tx: tx_keys, ty: ty_keys }
}

/// Parse ffmpeg's own `-i <path>` stderr banner ("Duration: 00:00:28.02, ...")
/// for the video's total length — avoids depending on ffprobe being installed
/// alongside ffmpeg (find_ffmpeg only locates the latter).
fn probe_duration_ms(path: &str, ffmpeg: &std::path::Path) -> Option<u32> {
    let output = quiet_command(ffmpeg).args(["-i", path]).output().ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let after = stderr.split("Duration: ").nth(1)?;
    let ts = after.split(',').next()?.trim();
    let mut parts = ts.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(((h * 3600.0 + m * 60.0 + s) * 1000.0).round() as u32)
}

/// Parse the frame rate off the same `-i <path>` stderr banner's video
/// stream line (ffmpeg prints e.g. "29.97 fps" there). Falls back to 30 —
/// good enough for a rebuild's export settings, not claimed as exact.
fn probe_fps(path: &str, ffmpeg: &std::path::Path) -> f32 {
    let Ok(output) = quiet_command(ffmpeg).args(["-i", path]).output() else { return 30.0 };
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        if !line.contains("Video:") {
            continue;
        }
        if let Some(fps_str) = line.split(" fps").next().and_then(|s| s.rsplit(", ").next()) {
            if let Ok(fps) = fps_str.trim().parse::<f32>() {
                if fps > 0.0 && fps < 240.0 {
                    return fps;
                }
            }
        }
    }
    30.0
}

/// 2.2: cut detection at the video's own native frame rate, not a fixed
/// low one — the roadmap's ±1 frame cut-timing target can't be met at a
/// coarser sampling rate than the source actually has. Cheap at 96px
/// grayscale even at full fps; `align_shot`/`look::analyze_look` stay on
/// their own lower, more expensive (colour, larger) sampling rates — only
/// cut SCORING needs every frame.
pub(crate) fn detect_cuts_native(path: &str, params: &shots::CutParams) -> Result<Vec<shots::Cut>, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found — install it to use shot detection")?;
    let fps = probe_fps(path, &ffmpeg);
    shots::detect_cuts(path, fps, 96, params)
}

/// Grayscale frames for `regions::detect_text_regions`, decoded directly
/// (own small ffmpeg pass — deliberately not sharing `align_shot`'s 256px
/// colour decode or `look::analyze_look`'s 64px colour decode; each of the
/// three per-shot passes wants a different size/format and this keeps them
/// independent rather than threading a shared cache through all of them).
/// `// ponytail: three separate ffmpeg decodes per shot (look, regions,
/// motion) plus detect_cuts' own pass over the whole video — a shared
/// decode-once cache would cut redundant work if this gets slow on long
/// references; not worth the complexity until it's measured as a problem.`
fn detect_regions_for_shot(path: &str, start_ms: u32, end_ms: u32) -> Result<Vec<regions::TextRegion>, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found — install it to analyze text regions")?;
    const SAMPLES: u32 = 12;
    const SIZE: u32 = 48;
    const COLS: u32 = 6;
    const ROWS: u32 = 8;
    let span = end_ms.saturating_sub(start_ms);
    if span == 0 {
        return Ok(Vec::new());
    }
    let scale = format!("scale={SIZE}:{SIZE}");
    let mut frames = Vec::with_capacity(SAMPLES as usize);
    for i in 0..SAMPLES {
        let t = start_ms + span * i / (SAMPLES - 1);
        let ts = format!("{:.3}", t as f64 / 1000.0);
        let output = quiet_command(&ffmpeg)
            .args(["-ss", &ts, "-i", path, "-frames:v", "1", "-vf", &scale, "-f", "rawvideo", "-pix_fmt", "gray", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| format!("ffmpeg: {e}"))?;
        let expected = (SIZE * SIZE) as usize;
        if output.status.success() && output.stdout.len() == expected {
            frames.push((t - start_ms, output.stdout));
        }
    }
    Ok(regions::detect_text_regions(&frames, SIZE, SIZE, COLS, ROWS))
}

/// One measured shot: its span, look/grade, best-effort text-region guesses,
/// and — when the shot has enough texture/duration to attempt it — its
/// recovered motion. `is_still` is a cheap proxy, not 2.3's real
/// still-vs-footage classifier: the aligner (`align_shot`) either converges
/// consistently on real camera-only motion (a photo under Ken Burns) or
/// fails/diverges often on footage and motion graphics (no single similarity
/// transform explains multiple independently-moving things) — so "did most
/// sampled frames solve" is a reasonable, cheap stand-in. Documented as a
/// simplification, not the full classifier the roadmap eventually wants.
#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ShotAnalysis {
    pub index: usize,
    pub start_ms: u32,
    pub end_ms: u32,
    pub is_still: bool,
    /// `t_ms` on each sample is relative to this shot's own start_ms (see
    /// `rebuildFromAnalysis.ts`'s `ShotAnalysis.motion` — same convention).
    /// Empty when the shot was too short to sample or motion wasn't
    /// attempted/didn't converge.
    pub motion: Vec<AlignSample>,
    pub look: look::ShotLook,
    pub text_regions: Vec<regions::TextRegion>,
    /// Whether this shot shows one full-frame image (`Single`, `regions`
    /// empty — the common case) or several at once (`Grid`/`MultiMotion`,
    /// `regions.len() > 1`) — see `layout::detect_shot_layout`. Never
    /// blocks the rest of the shot's measurement: a detection error here
    /// just falls back to `Single`.
    pub layout: layout::ShotLayout,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TemplateAnalysis {
    pub duration_ms: u32,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    pub cuts: Vec<shots::Cut>,
    pub shots: Vec<ShotAnalysis>,
}

/// Minimum shot length worth attempting motion recovery on — anything
/// shorter doesn't have enough samples (at 250ms spacing) for the aligner's
/// previous-frame-initialized walk to mean anything.
const MIN_MOTION_SHOT_MS: u32 = 500;
/// Fraction of sampled frames that must converge (`AlignSample.solved`) for
/// a shot to be called "still" — see `ShotAnalysis::is_still`'s doc.
const STILL_SOLVED_FRACTION: f32 = 0.8;

/// The actual "inverse-render a real edit's structure" entry point: cuts
/// (`shots::detect_cuts`) become shot boundaries, and each resulting shot is
/// measured for look/grade (`look::analyze_look`), candidate text/graphic
/// overlay regions (`detect_regions_for_shot`), and — when long enough —
/// motion (`align_shot`). Transition-FAMILY matching (which of the 25 engines
/// a cut resembles) isn't included here: it needs a browser Canvas to render
/// candidates, so it lives on the TS side (`match_transition` tool) as a
/// separate per-boundary call. Text CONTENT isn't read here either (no OCR) —
/// `text_regions` says where/when, not what; a human or Claude reading the
/// frames fills in the copy, same as the roadmap's own architecture assigns
/// that specifically to the AI layer, not a CV pass.
pub(crate) fn analyze_reference(path: &str) -> Result<TemplateAnalysis, String> {
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg not found — install it to analyze a reference")?;
    let duration_ms = probe_duration_ms(path, &ffmpeg).ok_or("could not determine the video's duration")?;
    let fps = probe_fps(path, &ffmpeg);

    let first_frame = extract_frames(path, &[0], 4096)?;
    let (width, height) = first_frame
        .first()
        .and_then(|(_, bytes)| image::load_from_memory(bytes).ok())
        .map(|im| (im.width(), im.height()))
        .unwrap_or((0, 0));

    let cuts = shots::detect_cuts(path, fps, 96, &shots::CutParams::default())?;

    let mut boundaries: Vec<u32> = cuts.iter().map(|c| c.t_ms).collect();
    boundaries.push(0);
    boundaries.push(duration_ms);
    boundaries.sort_unstable();
    boundaries.dedup();

    let mut shots_out = Vec::new();
    for (i, w) in boundaries.windows(2).enumerate() {
        let (start_ms, end_ms) = (w[0], w[1]);
        if end_ms <= start_ms {
            continue;
        }
        let look = look::analyze_look(path, start_ms, end_ms).unwrap_or(look::ShotLook {
            brightness: 1.0,
            contrast: 1.0,
            saturate: 1.0,
            vignette_strength: 0.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
        });
        let text_regions = detect_regions_for_shot(path, start_ms, end_ms).unwrap_or_default();
        let (is_still, motion) = if end_ms - start_ms >= MIN_MOTION_SHOT_MS {
            // 2.4's own "skip transition windows": align only the shot's
            // clean interior (past any in/out transition), so neither the
            // reference frame nor any walked sample is a blend of two shots.
            let (core_start, core_end) = shots::clean_core(start_ms, end_ms, &cuts);
            match align_shot(path, core_start, core_end, core_start, 250, 256) {
                Ok(samples) if !samples.is_empty() => {
                    let solved = samples.iter().filter(|s| s.solved).count() as f32 / samples.len() as f32;
                    let relative: Vec<AlignSample> = samples
                        .into_iter()
                        .map(|mut s| {
                            s.t_ms = s.t_ms.saturating_sub(start_ms);
                            s
                        })
                        .collect();
                    (solved >= STILL_SOLVED_FRACTION, relative)
                }
                _ => (false, Vec::new()),
            }
        } else {
            (false, Vec::new())
        };
        let shot_layout = layout::detect_shot_layout(path, start_ms, end_ms, 256)
            .unwrap_or(layout::ShotLayout { kind: layout::LayoutKind::Single, regions: Vec::new() });
        shots_out.push(ShotAnalysis { index: i, start_ms, end_ms, is_still, motion, look, text_regions, layout: shot_layout });
    }

    Ok(TemplateAnalysis { duration_ms, width, height, fps, cuts, shots: shots_out })
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
    fn fit_background_ignores_unsolved_carried_forward_samples() {
        // Mirrors a real live case: the aligner solves cleanly for a while,
        // then loses convergence and carries the last value forward
        // (`solved: false`) for the rest of the span. Fitting through those
        // placeholders as if they were real, unchanging motion would read a
        // late jump as an early, gradual ramp — check the unsolved tail is
        // excluded, not blended in.
        let mut samples = Vec::new();
        for t in (0..500).step_by(100) {
            samples.push(AlignSample { t_ms: t, scale: 1.0, rotation_deg: 0.0, tx: 0.0, ty: 0.0, solved: true });
        }
        samples.push(AlignSample { t_ms: 500, scale: 2.0, rotation_deg: 0.0, tx: 0.0, ty: 0.0, solved: true });
        for t in (600..1700).step_by(100) {
            samples.push(AlignSample { t_ms: t, scale: 2.0, rotation_deg: 0.0, tx: 0.0, ty: 0.0, solved: false });
        }
        let fitted = fit_background(&samples, 0, 1700);
        // No keys in the unsolved 600-1700 tail — it carries no real
        // information, so nothing there should have earned its own key.
        assert!(
            fitted.scale.iter().all(|k| k.time_ms <= 500 || k.time_ms == 1700),
            "expected no keys in the unsolved 600-1600 tail, got {:?}",
            fitted.scale
        );
        // Functional check, not a structural one — however many keys it
        // used, RENDERING the fitted track (the actual evaluator, not a
        // hand-rolled check) should reproduce the true step (flat at 1.0,
        // jump to 2.0 around t=500, held to the span end), not a gradual
        // ramp smeared across the unsolved tail.
        let track = crate::model::Track { keys: fitted.scale, default: 1.0 };
        assert!(crate::eval::sample_track(&track, 0) < 1.2, "expected ~1.0 near the start, got {}", crate::eval::sample_track(&track, 0));
        assert!(crate::eval::sample_track(&track, 1600) > 1.8, "expected ~2.0 well after the jump, got {}", crate::eval::sample_track(&track, 1600));
        assert_eq!(crate::eval::sample_track(&track, 1700), 2.0, "expected the span-edge value to hold the last real value");
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
