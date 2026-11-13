//! Subtitles: read subtitle files and Whisper transcripts (both via ffmpeg, as
//! SRT) into timed cues, and lay the cues out as Text layers in a "Subtitles"
//! group. Spec: docs/superpowers/specs/2026-11-13-subtitles-design.md.

use super::*;

/// One subtitle line: shown from `start_ms` to `end_ms`, `\n` between rows.
#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start_ms: u32,
    pub end_ms: u32,
    pub text: String,
}

/// Read SRT (as ffmpeg writes it, from any subtitle format or from Whisper).
/// Index lines are ignored (Whisper numbers from 0; some files have none).
/// Markup is stripped; cues with no text, or that don't move forward in time,
/// are dropped.
pub fn parse_srt(s: &str) -> Vec<Cue> {
    let s = s.strip_prefix('\u{feff}').unwrap_or(s);
    let mut cues = Vec::new();
    let mut cur: Option<(u32, u32, Vec<String>)> = None;
    let mut finish = |cur: &mut Option<(u32, u32, Vec<String>)>| {
        if let Some((start_ms, end_ms, rows)) = cur.take() {
            if !rows.is_empty() && end_ms > start_ms {
                cues.push(Cue { start_ms, end_ms, text: rows.join("\n") });
            }
        }
    };
    for line in s.lines() {
        if let Some((a, b)) = line.split_once("-->") {
            let end = b.split_whitespace().next().unwrap_or("");
            if let (Some(start_ms), Some(end_ms)) = (parse_time(a), parse_time(end)) {
                finish(&mut cur);
                cur = Some((start_ms, end_ms, Vec::new()));
                continue;
            }
        }
        if line.trim().is_empty() {
            finish(&mut cur);
        } else if let Some((_, _, rows)) = &mut cur {
            let row = strip_markup(line).trim().to_string();
            if !row.is_empty() {
                rows.push(row);
            }
        }
    }
    finish(&mut cur);
    cues
}

/// `HH:MM:SS,mmm` (or `.mmm`, or `MM:SS.mmm`) → ms.
fn parse_time(t: &str) -> Option<u32> {
    let t = t.trim();
    let (hms, frac) = t.split_once([',', '.']).unwrap_or((t, "0"));
    let mut secs: u64 = 0;
    for part in hms.split(':') {
        secs = secs * 60 + part.trim().parse::<u64>().ok()?;
    }
    let frac = format!("{:0<3}", &frac[..frac.len().min(3)]);
    let ms: u64 = frac.parse().ok()?;
    u32::try_from(secs * 1000 + ms).ok()
}

/// Remove HTML-style tags (`<i>`, `</font>`) and ASS override codes (`{\an8}`).
/// Only `<` before a letter or `/`, and `{` before `\`, start markup, so text
/// like "I <3 you" survives.
pub fn strip_markup(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    let mut close: Option<char> = None;
    while let Some(c) = chars.next() {
        match close {
            Some(end) => {
                if c == end {
                    close = None;
                }
            }
            None => {
                let next = chars.peek().copied();
                if c == '<' && next.is_some_and(|n| n.is_ascii_alphabetic() || n == '/') {
                    close = Some('>');
                } else if c == '{' && next == Some('\\') {
                    close = Some('}');
                } else {
                    out.push(c);
                }
            }
        }
    }
    out
}

/// Greedy word wrap: break `line` at spaces so each row measures ≤ `max_w`.
/// A single word wider than `max_w` keeps a row to itself.
pub fn wrap_line(line: &str, max_w: f32, measure: &dyn Fn(&str) -> f32) -> Vec<String> {
    let mut rows = Vec::new();
    let mut cur = String::new();
    for word in line.split_whitespace() {
        if cur.is_empty() {
            cur = word.to_string();
            continue;
        }
        let candidate = format!("{cur} {word}");
        if measure(&candidate) <= max_w {
            cur = candidate;
        } else {
            rows.push(std::mem::replace(&mut cur, word.to_string()));
        }
    }
    if !cur.is_empty() || rows.is_empty() {
        rows.push(cur);
    }
    rows
}

/// What an import or transcription did: the new project, how many lines it
/// placed, and how many fell outside the comp and were left out.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SubtitleResult {
    pub project: Project,
    pub lines: u32,
    pub dropped: u32,
}

/// White text with a black outline, so it reads on any footage.
fn subtitle_style(size: f32) -> crate::model::TextStyle {
    crate::model::TextStyle {
        fills: vec![],
        strokes: vec![crate::model::TextStroke {
            color: Rgba { r: 0, g: 0, b: 0, a: 255 },
            opacity: 100.0,
            width: (0.08 * size).max(1.0),
            position: crate::model::StrokePosition::Outside,
        }],
        fill_over_stroke: true,
        tracking: Track::constant(0.0),
        leading: 0.0,
        baseline_shift: Track::constant(0.0),
        font_family: None,
        fallback_stack: vec![],
        font_style: None,
        variable_axes: Default::default(),
    }
}

/// Lay `cues` out as Text layers inside one new "Subtitles" group pushed on top
/// of `p`, and fit the comp the way adding media does. Cues past the comp's
/// limit (a hand-set length, else the 1-hour cap) are dropped; ones running
/// past it are trimmed. Lines are bottom-anchored: a cue's last row sits on
/// the subtitle line (88% down) and extra rows grow upward. A cue that's on
/// screen with others takes the lowest run of free rows above them.
/// `measure(text, size)` is the rendered (width, line height). Returns
/// (placed, dropped); pushes nothing when no cue survives. Doesn't snapshot —
/// the caller does.
pub fn place_cues(p: &mut Project, mut cues: Vec<Cue>, measure: &dyn Fn(&str, f32) -> (f32, f32)) -> (u32, u32) {
    let limit = if p.duration_set_by_user { p.duration_ms } else { MAX_COMP_MS };
    let (w, h) = (p.width as f32, p.height as f32);
    let size = (0.055 * w.min(h)).round();
    let line_h = measure("Ag", size).1;
    let width = |s: &str| measure(s, size).0;
    let mut next_id = max_layer_id(&p.layers) + 1;
    let mut dropped = 0;
    let mut placed: Vec<(u32, usize, usize)> = Vec::new(); // (end_ms, first row slot, rows) per line
    let mut children = Vec::new();
    cues.sort_by_key(|c| c.start_ms); // packing assumes time order (ASS files needn't be)
    for c in cues {
        if c.start_ms + MIN_SPAN_MS > limit {
            dropped += 1;
            continue;
        }
        let end_ms = c.end_ms.min(limit).max(c.start_ms + MIN_SPAN_MS);
        let rows: Vec<String> = c.text.split('\n').flat_map(|row| wrap_line(row, 0.9 * w, &width)).collect();
        let n = rows.len();
        // Row slots (0 = the subtitle line, counting up) of lines still on screen.
        let busy: Vec<(usize, usize)> =
            placed.iter().filter(|(end, _, _)| *end > c.start_ms).map(|&(_, s, r)| (s, s + r)).collect();
        let mut slot = 0;
        while let Some(&(_, taken_to)) = busy.iter().find(|&&(a, b)| slot < b && a < slot + n) {
            slot = taken_to;
        }
        // Blocks are centred on their y, so lift by half the extra rows.
        let y = 0.88 * h - slot as f32 * line_h - (n - 1) as f32 * line_h / 2.0;
        placed.push((end_ms, slot, n));
        let mut layer = new_text_layer(next_id, rows.join("\n"), size, w / 2.0, y, c.start_ms, end_ms);
        next_id += 1;
        if let LayerKind::Text { color, style, .. } = &mut layer.kind {
            *color = Rgba { r: 255, g: 255, b: 255, a: 255 };
            *style = Some(subtitle_style(size));
        }
        children.push(layer);
    }
    if children.is_empty() {
        return (0, dropped);
    }
    let lines = children.len() as u32;
    let start_ms = children.iter().map(|l| l.start_ms).min().unwrap_or(0);
    let end_ms = children.iter().map(|l| l.end_ms).max().unwrap_or(0);
    let was_fit = comp_is_fit(p);
    p.layers.push(Layer {
        id: next_id,
        name: "Subtitles".into(),
        start_ms,
        end_ms,
        kind: LayerKind::Group { children },
        transform: Transform::at(0.0, 0.0),
        hidden: false,
        attach: None,
        effects: vec![],
        transition_in: None,
        transition_out: None,
    });
    refit_comp(p, was_fit);
    (lines, dropped)
}

/// Rendered (width, line height) of `s` in the subtitle font.
fn measure_text(s: &str, size: f32) -> (f32, f32) {
    let shaped = text::shape(s, size, &Font("Vazirmatn".into()), 400, false);
    (shaped.width, shaped.line_height)
}

/// The `-sub_charenc` a subtitle file needs: none when it's UTF-8 or UTF-16
/// (ffmpeg reads those), else the Windows ANSI code page (`acp`, e.g. "1256"
/// on Arabic/Persian Windows), defaulting to Western "CP1252". Without it
/// ffmpeg silently drops every cue that isn't valid UTF-8.
pub fn sub_charenc(bytes: &[u8], acp: Option<&str>) -> Option<String> {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return None;
    }
    if std::str::from_utf8(bytes).is_ok() {
        return None;
    }
    let cp = acp
        .filter(|c| !c.is_empty() && c.bytes().all(|b| b.is_ascii_digit()) && *c != "65001")
        .unwrap_or("1252");
    Some(format!("CP{cp}"))
}

/// The Windows ANSI code page ("1252", "1256"…), the encoding old subtitle
/// files on this PC were most likely saved in. None off Windows.
fn ansi_code_page() -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let out = quiet_command("reg")
        .args(["query", r"HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage", "/v", "ACP"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().find(|l| l.trim_start().starts_with("ACP"))?.split_whitespace().last().map(str::to_string)
}

/// Whisper writes `[Music]`, `(applause)`, `♪♪` for non-speech. Not subtitles.
/// True when every row is one bracketed tag or only music notes.
pub fn is_sound_tag(text: &str) -> bool {
    text.lines().map(str::trim).filter(|l| !l.is_empty()).all(|l| {
        (l.starts_with('[') && l.ends_with(']'))
            || (l.starts_with('(') && l.ends_with(')'))
            || l.chars().all(|c| c == '♪' || c == '♫' || c.is_whitespace())
    })
}

// --- Speech → subtitles: Whisper models and an ffmpeg that can run them -------

/// A whisper.cpp model file and what a good download of it looks like (size and
/// SHA-256 from Hugging Face's X-Linked-Size / X-Linked-ETag headers).
pub struct WhisperModel {
    pub file: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

const MODEL_URL_PREFIX: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

/// "fast" → base (multilingual, ~148 MB); "accurate" → large-v3-turbo q5_0 (~574 MB).
pub fn whisper_model(quality: &str) -> Result<WhisperModel, String> {
    match quality {
        "fast" => Ok(WhisperModel {
            file: "ggml-base.bin",
            size: 147_951_465,
            sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        }),
        "accurate" => Ok(WhisperModel {
            file: "ggml-large-v3-turbo-q5_0.bin",
            size: 574_041_195,
            sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        }),
        q => Err(format!("unknown speech-model quality {q:?}")),
    }
}

/// `%LOCALAPPDATA%\Simple Effects\whisper-models\` (created).
pub fn models_dir() -> Result<std::path::PathBuf, String> {
    app_data_dir("whisper-models")
}

/// The model is fully there. Its checksum was verified when it was downloaded
/// (it's only renamed into place after that), so the size check is enough here.
pub fn model_ready_in(dir: &std::path::Path, m: &WhisperModel) -> bool {
    std::fs::metadata(dir.join(m.file)).map(|md| md.is_file() && md.len() == m.size).unwrap_or(false)
}

/// `ffmpeg -filters` output lists the `whisper` filter (ffmpeg 8+ built with it).
pub fn has_whisper_filter(filters_stdout: &str) -> bool {
    filters_stdout.lines().any(|l| l.split_whitespace().nth(1) == Some("whisper"))
}

fn ffmpeg_has_whisper(ff: &std::path::Path) -> bool {
    quiet_command(ff)
        .args(["-hide_banner", "-filters"])
        .output()
        .map(|o| has_whisper_filter(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false)
}

/// An ffmpeg that can transcribe: the one export uses if it has the filter, else
/// the winget Gyan build (PATH may point at an older or slimmer build). Export's
/// own choice of ffmpeg is untouched.
pub fn find_whisper_ffmpeg() -> Result<std::path::PathBuf, String> {
    let mut candidates: Vec<std::path::PathBuf> = find_ffmpeg().into_iter().collect();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let pkgs = std::path::Path::new(&local).join("Microsoft").join("WinGet").join("Packages");
        if let Some(p) = find_exe(&pkgs, "ffmpeg.exe", 5) {
            if !candidates.contains(&p) {
                candidates.push(p);
            }
        }
    }
    if candidates.is_empty() {
        return Err("Speech detection needs ffmpeg 8 or later with Whisper, and ffmpeg isn't installed.".into());
    }
    if let Some(ok) = candidates.iter().find(|c| ffmpeg_has_whisper(c)) {
        return Ok(ok.clone());
    }
    let checked: Vec<String> = candidates
        .iter()
        .map(|p| if p.as_os_str() == "ffmpeg" { "ffmpeg on PATH".to_string() } else { p.display().to_string() })
        .collect();
    Err(format!("Speech detection needs ffmpeg 8 or later with Whisper. Checked: {}", checked.join(", ")))
}

/// Is the speech model for `quality` downloaded?
#[tauri::command]
pub fn whisper_model_ready(quality: String) -> Result<bool, String> {
    Ok(model_ready_in(&models_dir()?, &whisper_model(&quality)?))
}

/// Download the speech model for `quality` (once). Goes to `<file>.part`, is
/// checked against the pinned size + SHA-256, then renamed into place, so a
/// partial or corrupt file is never used. Cancel (`cancel_export`) stops it.
#[tauri::command(async)]
pub fn download_whisper_model(quality: String) -> Result<(), String> {
    let m = whisper_model(&quality)?;
    let dir = models_dir()?;
    if model_ready_in(&dir, &m) {
        return Ok(());
    }
    begin_export();
    let part = dir.join(format!("{}.part", m.file));
    let mut cmd = quiet_command("curl.exe");
    cmd.args(["-fsSL", "--retry", "2", "--speed-limit", "1024", "--speed-time", "60", "-o"])
        .arg(&part)
        .arg(format!("{MODEL_URL_PREFIX}{}", m.file));
    // ponytail: check_download reads the whole file (up to 574 MB) into memory; stream the hash if low-memory PCs complain
    let done = run_cancellable(cmd, &part, "curl")
        .and_then(|_| check_download(&part, m.size, m.sha256))
        .and_then(|_| std::fs::rename(&part, dir.join(m.file)).map_err(|e| format!("save the speech model: {e}")));
    if done.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    done
}

/// Get an ffmpeg that has the Whisper filter: upgrade the winget Gyan build
/// (a plain install doesn't upgrade a pre-8.0 one), or install it if absent.
#[tauri::command(async)]
pub fn update_ffmpeg() -> Result<String, String> {
    let _ = quiet_command("winget")
        .args([
            "upgrade",
            "--id",
            "Gyan.FFmpeg",
            "-e",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--disable-interactivity",
        ])
        .output();
    if find_whisper_ffmpeg().is_err() {
        let _ = install_ffmpeg();
    }
    find_whisper_ffmpeg().map(|p| p.display().to_string())
}

/// The part of a media clip the timeline plays, in source time: `src_len_ms`
/// from `in_ms`, shown from comp time `start_ms` at `speed`.
#[derive(Debug, Clone, Copy)]
pub struct SourceWindow {
    pub in_ms: u32,
    pub src_len_ms: u32,
    pub start_ms: u32,
    pub speed: f32,
}

/// What a video/audio layer plays. Reversed clips are refused (speech backwards
/// can't be transcribed), as is anything that isn't video or audio.
pub fn source_window(layer: &Layer) -> Result<SourceWindow, String> {
    let (in_ms, speed, reverse) = match &layer.kind {
        LayerKind::Video { in_ms, speed, reverse, .. } | LayerKind::Audio { in_ms, speed, reverse, .. } => {
            (*in_ms, *speed, *reverse)
        }
        _ => return Err("Subtitles can only be generated from a video or audio clip.".into()),
    };
    if reverse {
        return Err("Subtitles can't be generated for a reversed clip.".into());
    }
    if !(speed > 0.0) {
        return Err("This clip's playback speed isn't valid.".into());
    }
    let span = layer.end_ms.saturating_sub(layer.start_ms);
    Ok(SourceWindow { in_ms, src_len_ms: (span as f32 * speed).round() as u32, start_ms: layer.start_ms, speed })
}

/// Transcript times (relative to the trimmed source start) → comp times.
pub fn to_comp_cues(cues: Vec<Cue>, w: &SourceWindow) -> Vec<Cue> {
    let at = |ms: u32| w.start_ms + (ms as f32 / w.speed).round() as u32;
    cues.into_iter().map(|c| Cue { start_ms: at(c.start_ms), end_ms: at(c.end_ms), text: c.text }).collect()
}

/// The `-af` argument. File names only: ffmpeg runs from the models folder,
/// because absolute Windows paths need double escaping in filter arguments and
/// an apostrophe in the user folder breaks even that. `language` is checked so
/// it can't smuggle extra filter options in.
pub fn whisper_af(model_file: &str, language: &str, max_len: u32, dest_file: &str) -> Result<String, String> {
    let ok = language == "auto"
        || ((2..=3).contains(&language.len()) && language.bytes().all(|b| b.is_ascii_lowercase()));
    if !ok {
        return Err(format!("unsupported language {language:?}"));
    }
    Ok(format!(
        "whisper=model={model_file}:language={language}:queue=20:max_len={max_len}:destination={dest_file}:format=srt"
    ))
}

/// Longest subtitle line Whisper should write: 42 characters is the usual
/// line; tall comps get 24 so lines stay short in time as well as width.
pub fn max_len_for(width: u32, height: u32) -> u32 {
    if height > width {
        24
    } else {
        42
    }
}

/// Right-click a video/audio clip → Generate Subtitles from Speech…: transcribe
/// the part of the clip the timeline plays (offline, with ffmpeg's Whisper
/// filter) into a "Subtitles" group. The model must already be downloaded.
/// Cancel (`cancel_export`) stops it. Undoable.
#[tauri::command(async)]
pub fn transcribe_layer(
    state: State<'_, AppState>,
    layer_id: u32,
    quality: String,
    language: String,
) -> Result<SubtitleResult, String> {
    // Copy what we need and let go of the project: transcription takes a while.
    let (layer, width, height) = {
        let p = state.project.lock().unwrap();
        let l = p.layers.iter().find(|l| l.id == layer_id).cloned().ok_or("layer not found")?;
        (l, p.width, p.height)
    };
    let window = source_window(&layer)?;
    let src = match &layer.kind {
        LayerKind::Video { src, .. } | LayerKind::Audio { src, .. } => src.clone(),
        _ => return Err("Subtitles can only be generated from a video or audio clip.".into()),
    };
    let model = whisper_model(&quality)?;
    let dir = models_dir()?;
    if !model_ready_in(&dir, &model) {
        return Err("The speech model isn't downloaded yet.".into());
    }
    let ff = find_whisper_ffmpeg()?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = format!("transcript-{stamp}.srt");
    let af = whisper_af(model.file, &language, max_len_for(width, height), &dest)?;
    let secs = |ms: u32| format!("{:.3}", ms as f64 / 1000.0);
    begin_export();
    let mut cmd = quiet_command(&ff);
    cmd.current_dir(&dir)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &secs(window.in_ms), "-t", &secs(window.src_len_ms), "-i"])
        .arg(&src)
        .args(["-vn", "-af", &af, "-f", "null", "-"]);
    let out_path = dir.join(&dest);
    let ran = run_cancellable(cmd, &out_path, "ffmpeg");
    // No speech can mean no file at all; that reads as "no cues" below.
    let srt = std::fs::read(&out_path).unwrap_or_default();
    let _ = std::fs::remove_file(&out_path);
    ran?;
    let speech: Vec<Cue> = parse_srt(&String::from_utf8_lossy(&srt)).into_iter().filter(|c| !is_sound_tag(&c.text)).collect();
    place_into_state(&state, to_comp_cues(speech, &window), "No speech found in this clip.")
}

/// Place cues into the live project as one undo step. `empty` is the error when
/// nothing could be placed (then the project and undo history are untouched).
fn place_into_state(state: &AppState, cues: Vec<Cue>, empty: &str) -> Result<SubtitleResult, String> {
    let mut project = state.project.lock().unwrap();
    let before = project.clone();
    let (lines, dropped) = place_cues(&mut project, cues, &measure_text);
    if lines == 0 {
        return Err(empty.into());
    }
    state.snapshot(&before);
    if let Some(group) = project.layers.last() {
        reshape_recursive(&mut state.shaped.lock().unwrap(), group);
    }
    Ok(SubtitleResult { project: project.clone(), lines, dropped })
}

/// File → Import Subtitles…: any format ffmpeg reads (SRT, VTT, ASS/SSA,
/// MicroDVD, SAMI…) → SRT → a "Subtitles" group of text layers. Undoable.
#[tauri::command(async)]
pub fn import_subtitles(state: State<'_, AppState>, path: String) -> Result<SubtitleResult, String> {
    let ff = find_ffmpeg().ok_or("Subtitles need ffmpeg. Open File → Export Video… to install it.")?;
    // Old SRTs are often Windows-1252/1256, not UTF-8; ffmpeg silently drops
    // those cues unless told the encoding. Sniff the start of the file (subtitle
    // files are small; "All files" could pick something huge).
    const SNIFF: u64 = 8 << 20;
    let mut head = Vec::new();
    {
        use std::io::Read;
        std::fs::File::open(&path)
            .and_then(|f| f.take(SNIFF).read_to_end(&mut head))
            .map_err(|e| format!("Couldn't open this file: {e}"))?;
    }
    if head.len() as u64 == SNIFF {
        // A partial read can split a UTF-8 character: check whole lines only.
        let cut = head.iter().rposition(|&b| b == b'\n').unwrap_or(0);
        head.truncate(cut);
    }
    let mut cmd = quiet_command(&ff);
    cmd.args(["-hide_banner", "-loglevel", "error"]);
    if let Some(enc) = sub_charenc(&head, ansi_code_page().as_deref()) {
        cmd.args(["-sub_charenc", &enc]);
    }
    let out = cmd
        .arg("-i")
        .arg(&path)
        .args(["-f", "srt", "-"])
        .output()
        .map_err(|e| format!("run ffmpeg: {e}"))?;
    if !out.status.success() {
        return Err(format!("Couldn't read this subtitle file: {}", stderr_tail(&out.stderr)));
    }
    let cues = parse_srt(&String::from_utf8_lossy(&out.stdout));
    place_into_state(&state, cues, "No subtitles found in this file.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_whisper_style_srt_numbered_from_zero() {
        let s = "0\n00:00:00,000 --> 00:00:05,120\nWelcome to Simple Effects.\n\n1\n00:00:05,120 --> 00:00:12,000\nFirst, import a subtitle file.\n";
        assert_eq!(
            parse_srt(s),
            vec![
                Cue { start_ms: 0, end_ms: 5120, text: "Welcome to Simple Effects.".into() },
                Cue { start_ms: 5120, end_ms: 12000, text: "First, import a subtitle file.".into() },
            ]
        );
    }

    #[test]
    fn tolerates_bom_crlf_dot_millis_missing_index_and_multiline() {
        let s = "\u{feff}00:00:01.500 --> 00:00:03.000\r\nHello\r\nsecond line\r\n\r\n";
        assert_eq!(parse_srt(s), vec![Cue { start_ms: 1500, end_ms: 3000, text: "Hello\nsecond line".into() }]);
    }

    #[test]
    fn strips_tags_and_override_codes() {
        // Exactly what ffmpeg produced from an ASS file on 2026-11-13.
        let s = "1\n00:00:01,500 --> 00:00:03,000\n<font size=\"20\">{\\an8}Hello <i>there</i>\nsecond line</font>\n";
        assert_eq!(parse_srt(s)[0].text, "Hello there\nsecond line");
    }

    #[test]
    fn drops_empty_and_backwards_cues() {
        let s = "1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n\n2\n00:00:05,000 --> 00:00:04,000\nback\n\n3\n00:00:06,000 --> 00:00:07,000\nok\n";
        assert_eq!(parse_srt(s).len(), 1);
    }

    #[test]
    fn hours_parse() {
        assert_eq!(parse_srt("01:02:03,004 --> 01:02:04,000\nx\n")[0].start_ms, 3_723_004);
    }

    #[test]
    fn wraps_at_word_boundaries_to_fit() {
        let m = |s: &str| s.chars().count() as f32 * 10.0; // 10 px per char
        assert_eq!(wrap_line("one two three four", 105.0, &m), vec!["one two", "three four"]);
        assert_eq!(wrap_line("short", 105.0, &m), vec!["short"]);
        assert_eq!(wrap_line("supercalifragilistic", 105.0, &m), vec!["supercalifragilistic"]); // one long word stays whole
    }

    // --- Task 2: cues → "Subtitles" group ---------------------------------

    /// Fake shaping: (width, line height) = (½ size per char, 1.5 × size).
    fn m(s: &str, size: f32) -> (f32, f32) {
        (s.chars().count() as f32 * size * 0.5, size * 1.5)
    }
    fn cue(a: u32, b: u32, t: &str) -> Cue {
        Cue { start_ms: a, end_ms: b, text: t.into() }
    }
    fn landscape() -> Project {
        let mut p = Project::empty();
        p.width = 1920;
        p.height = 1080;
        p
    }

    #[test]
    fn cues_become_text_layers_in_one_subtitles_group() {
        let mut p = landscape();
        assert_eq!(place_cues(&mut p, vec![cue(0, 1000, "Hi"), cue(1000, 2500, "There")], &m), (2, 0));
        assert_eq!(p.layers.len(), 1);
        let g = &p.layers[0];
        assert_eq!((g.name.as_str(), g.start_ms, g.end_ms), ("Subtitles", 0, 2500));
        let LayerKind::Group { children } = &g.kind else { panic!("not a group") };
        assert_eq!(children.len(), 2);
        let LayerKind::Text { content, size, .. } = &children[1].kind else { panic!("not text") };
        assert_eq!((content.as_str(), *size), ("There", 59.0)); // round(0.055 * 1080)
        assert_eq!((children[1].start_ms, children[1].end_ms), (1000, 2500));
        assert_eq!(children[0].transform.y.default, 0.88 * 1080.0);
        let ids: std::collections::HashSet<u32> = children.iter().map(|c| c.id).chain([g.id]).collect();
        assert_eq!(ids.len(), 3); // all ids unique
    }

    #[test]
    fn portrait_size_uses_the_shorter_side_and_long_lines_wrap() {
        let mut p = Project::empty(); // 1080x1920
        place_cues(&mut p, vec![cue(0, 1000, "a fairly long subtitle line that will not fit in one row")], &m);
        let LayerKind::Group { children } = &p.layers[0].kind else { panic!() };
        let LayerKind::Text { content, size, .. } = &children[0].kind else { panic!() };
        assert_eq!(*size, 59.0);
        assert!(content.contains('\n'));
        assert!(content.lines().all(|l| m(l, 59.0).0 <= 0.9 * 1080.0 || !l.contains(' ')));
    }

    #[test]
    fn no_cues_adds_nothing() {
        let mut p = landscape();
        assert_eq!(place_cues(&mut p, vec![], &m), (0, 0));
        assert!(p.layers.is_empty());
    }

    #[test]
    fn fit_comp_grows_to_the_last_cue() {
        let mut p = landscape(); // 4000 ms, fit
        place_cues(&mut p, vec![cue(0, 1000, "a"), cue(9000, 12000, "b")], &m);
        assert_eq!(p.duration_ms, 12000);
    }

    #[test]
    fn hand_set_length_drops_late_cues_and_trims_overrunning_ones() {
        let mut p = landscape();
        p.duration_set_by_user = true; // 4000 ms
        assert_eq!(
            place_cues(&mut p, vec![cue(0, 1000, "a"), cue(3500, 5000, "b"), cue(4000, 4500, "c")], &m),
            (2, 1)
        );
        assert_eq!(p.duration_ms, 4000);
        let LayerKind::Group { children } = &p.layers[0].kind else { panic!() };
        assert_eq!(children[1].end_ms, 4000);
    }

    #[test]
    fn cues_past_the_comp_cap_are_dropped() {
        let mut p = landscape();
        assert_eq!(
            place_cues(&mut p, vec![cue(0, 1000, "a"), cue(MAX_COMP_MS, MAX_COMP_MS + 1000, "late")], &m),
            (1, 1)
        );
    }

    #[test]
    fn overlapping_cues_stack_upward() {
        let mut p = landscape();
        place_cues(&mut p, vec![cue(0, 3000, "speaker one"), cue(1000, 2000, "speaker two")], &m);
        let LayerKind::Group { children } = &p.layers[0].kind else { panic!() };
        assert!(children[1].transform.y.default < children[0].transform.y.default);
    }

    // --- Task 4: models + a whisper-capable ffmpeg ---------------------------

    #[test]
    fn model_table_matches_the_spec() {
        let f = whisper_model("fast").unwrap();
        assert_eq!((f.file, f.size), ("ggml-base.bin", 147951465));
        assert_eq!(f.sha256, "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe");
        let a = whisper_model("accurate").unwrap();
        assert_eq!((a.file, a.size), ("ggml-large-v3-turbo-q5_0.bin", 574041195));
        assert_eq!(a.sha256, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2");
        assert!(whisper_model("huge").is_err());
    }

    #[test]
    fn only_a_complete_model_file_counts_as_ready() {
        let dir = std::env::temp_dir().join(format!("se-models-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let m = WhisperModel { file: "t.bin", size: 1000, sha256: "" };
        assert!(!model_ready_in(&dir, &m)); // missing
        std::fs::File::create(dir.join("t.bin.part")).unwrap().set_len(1000).unwrap();
        assert!(!model_ready_in(&dir, &m)); // only a .part
        std::fs::File::create(dir.join("t.bin")).unwrap().set_len(999).unwrap();
        assert!(!model_ready_in(&dir, &m)); // wrong size
        std::fs::File::create(dir.join("t.bin")).unwrap().set_len(1000).unwrap();
        assert!(model_ready_in(&dir, &m));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_the_whisper_filter_line() {
        assert!(has_whisper_filter(" .. afir              N->A       Apply Finite Impulse Response filter.\n .. whisper           A->A       Transcribe audio using whisper.cpp.\n"));
        assert!(!has_whisper_filter(" .. afir              N->A       Apply Finite Impulse Response filter.\n"));
    }

    // --- Task 5: speech → subtitles ------------------------------------------

    fn video(start: u32, end: u32, in_ms: u32, speed: f32, reverse: bool) -> Layer {
        Layer {
            id: 1,
            name: "v".into(),
            start_ms: start,
            end_ms: end,
            kind: LayerKind::Video { src: "a.mp4".into(), width: 1920, height: 1080, duration_ms: 60_000, in_ms, speed, reverse },
            transform: Transform::at(0.0, 0.0),
            hidden: false,
            attach: None,
            effects: vec![],
            transition_in: None,
            transition_out: None,
        }
    }

    #[test]
    fn maps_trimmed_sped_up_source_time_to_comp_time() {
        let w = SourceWindow { in_ms: 1000, src_len_ms: 4000, start_ms: 2000, speed: 2.0 };
        assert_eq!(to_comp_cues(vec![cue(3000, 4000, "x")], &w), vec![cue(3500, 4000, "x")]);
    }

    #[test]
    fn source_window_reads_the_played_span_and_refuses_reversed_clips() {
        let w = source_window(&video(2000, 4000, 1000, 2.0, false)).unwrap();
        assert_eq!((w.in_ms, w.src_len_ms, w.start_ms, w.speed), (1000, 4000, 2000, 2.0));
        assert!(source_window(&video(2000, 4000, 1000, 2.0, true)).unwrap_err().contains("reversed"));
        assert!(source_window(&crate::new_text_layer(2, "t".into(), 10.0, 0.0, 0.0, 0, 1000)).is_err());
    }

    #[test]
    fn filter_string_has_no_paths_and_rejects_injected_options() {
        let af = whisper_af("ggml-base.bin", "auto", 42, "transcript-1.srt").unwrap();
        assert_eq!(af, "whisper=model=ggml-base.bin:language=auto:queue=20:max_len=42:destination=transcript-1.srt:format=srt");
        assert!(!af.contains('\\'));
        assert!(whisper_af("ggml-base.bin", "en:destination=x", 42, "t.srt").is_err());
    }

    // --- Final-review fixes ----------------------------------------------------

    /// (top, bottom, start, end) of every subtitle line: the block is centred on
    /// its y, `rows` rows of 1.5 × size (the fake line height in `m`).
    fn boxes(p: &Project) -> Vec<(f32, f32, u32, u32)> {
        let LayerKind::Group { children } = &p.layers[0].kind else { panic!() };
        children
            .iter()
            .map(|c| {
                let LayerKind::Text { content, size, .. } = &c.kind else { panic!() };
                let half = content.lines().count() as f32 * size * 1.5 / 2.0;
                (c.transform.y.default - half, c.transform.y.default + half, c.start_ms, c.end_ms)
            })
            .collect()
    }
    fn assert_no_overlaps(p: &Project) {
        let b = boxes(p);
        for i in 0..b.len() {
            for j in i + 1..b.len() {
                let on_screen_together = b[i].2 < b[j].3 && b[j].2 < b[i].3;
                let overlap = b[i].0 < b[j].1 - 0.01 && b[j].0 < b[i].1 - 0.01;
                assert!(!(on_screen_together && overlap), "lines {i} and {j} overlap: {:?} vs {:?}", b[i], b[j]);
            }
        }
    }

    #[test]
    fn alternating_speakers_never_reuse_a_taken_slot() {
        let mut p = landscape();
        place_cues(&mut p, vec![cue(0, 2000, "A one"), cue(1500, 3500, "B one"), cue(3000, 5000, "A two")], &m);
        assert_no_overlaps(&p);
    }

    #[test]
    fn two_row_cues_stack_without_overlapping() {
        let mut p = landscape();
        place_cues(&mut p, vec![cue(0, 3000, "one row"), cue(1000, 2000, "first row\nsecond row")], &m);
        assert_no_overlaps(&p);
    }

    #[test]
    fn a_multi_row_cue_grows_upward_from_the_subtitle_line() {
        let mut p = landscape();
        place_cues(&mut p, vec![cue(0, 1000, "row one\nrow two")], &m);
        let LayerKind::Group { children } = &p.layers[0].kind else { panic!() };
        let lh = 59.0 * 1.5;
        // The bottom row's centre sits on the subtitle line (88% down).
        assert!((children[0].transform.y.default + lh / 2.0 - 0.88 * 1080.0).abs() < 0.01);
    }

    #[test]
    fn non_utf8_files_get_the_windows_code_page() {
        assert_eq!(sub_charenc("Café".as_bytes(), Some("1252")), None); // already UTF-8
        assert_eq!(sub_charenc(b"\xef\xbb\xbfCaf\xc3\xa9", Some("1252")), None); // UTF-8 with BOM
        assert_eq!(sub_charenc(b"\xff\xfeC\x00", Some("1252")), None); // UTF-16 LE: ffmpeg detects it
        assert_eq!(sub_charenc(b"\xfe\xff\x00C", Some("1252")), None); // UTF-16 BE
        assert_eq!(sub_charenc(b"Caf\xe9 cr\xe8me", Some("1252")).as_deref(), Some("CP1252"));
        assert_eq!(sub_charenc(b"\xc7\xe1\xe3", Some("1256")).as_deref(), Some("CP1256")); // Arabic Windows
        assert_eq!(sub_charenc(b"Caf\xe9", None).as_deref(), Some("CP1252")); // unknown → Western
    }

    #[test]
    fn whisper_sound_tags_are_not_subtitles() {
        for t in ["[Music]", "[Motor]", "(applause)", "♪", "♪♪", "♪ ♪", "[Music]\n[Applause]"] {
            assert!(is_sound_tag(t), "{t:?} should be a sound tag");
        }
        for t in ["Hello [laughs]", "♪ la la la ♪", "(He) said yes", "Hello"] {
            assert!(!is_sound_tag(t), "{t:?} is speech");
        }
    }

    #[test]
    fn line_length_follows_comp_shape() {
        assert_eq!(max_len_for(1920, 1080), 42);
        assert_eq!(max_len_for(1080, 1080), 42);
        assert_eq!(max_len_for(1080, 1920), 24);
    }
}
