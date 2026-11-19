//! Read an MP4/MOV file's track list without decoding: walk the box headers,
//! seeking past media data, and look for a `soun` handler inside `moov`. Other
//! containers report `None` so the frontend falls back to its browser check.

use std::io::{Read, Seek, SeekFrom};

/// The most boxes a plausible file can have; a corrupt size chain could otherwise
/// spin forever.
const MAX_BOXES: u32 = 100_000;

/// `(type, body start, body end)` of the box at `pos` inside `[pos, end)`.
fn read_box<R: Read + Seek>(r: &mut R, pos: u64, end: u64, n: &mut u32) -> Option<([u8; 4], u64, u64)> {
    *n += 1;
    if *n > MAX_BOXES || pos.checked_add(8)? > end {
        return None;
    }
    r.seek(SeekFrom::Start(pos)).ok()?;
    let mut h = [0u8; 8];
    r.read_exact(&mut h).ok()?;
    let size32 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]);
    let kind = [h[4], h[5], h[6], h[7]];
    // Matroska/WebM, AVI and random bytes have non-printable type bytes.
    if !kind.iter().all(|b| (0x20..=0x7E).contains(b)) {
        return None;
    }
    let (header, size) = if size32 == 1 {
        if pos.checked_add(16)? > end {
            return None;
        }
        let mut b = [0u8; 8];
        r.read_exact(&mut b).ok()?;
        (16u64, u64::from_be_bytes(b))
    } else if size32 == 0 {
        (8u64, end - pos) // runs to the end of its parent
    } else {
        (8u64, size32 as u64)
    };
    if size < header {
        return None;
    }
    let body = pos.checked_add(header)?;
    let next = pos.checked_add(size)?;
    if next > end {
        return None;
    }
    Some((kind, body, next))
}

/// Walk `[start, end)` for a `trak` whose `mdia`/`hdlr` names a sound handler.
fn hdlr_is_sound<R: Read + Seek>(r: &mut R, start: u64, end: u64, n: &mut u32) -> Option<bool> {
    let mut pos = start;
    while pos < end {
        let (kind, body, next) = read_box(r, pos, end, n)?;
        if &kind == b"hdlr" && next.saturating_sub(body) >= 12 {
            // ISO: version/flags + pre_defined + handler type. QuickTime: the same
            // offset holds the component subtype.
            r.seek(SeekFrom::Start(body + 8)).ok()?;
            let mut h = [0u8; 4];
            r.read_exact(&mut h).ok()?;
            if &h == b"soun" {
                return Some(true);
            }
        }
        pos = next;
    }
    Some(false)
}

fn mdia_has_sound<R: Read + Seek>(r: &mut R, start: u64, end: u64, n: &mut u32) -> Option<bool> {
    hdlr_is_sound(r, start, end, n)
}

fn trak_has_sound<R: Read + Seek>(r: &mut R, start: u64, end: u64, n: &mut u32) -> Option<bool> {
    let mut pos = start;
    while pos < end {
        let (kind, body, next) = read_box(r, pos, end, n)?;
        if &kind == b"mdia" {
            return mdia_has_sound(r, body, next, n);
        }
        pos = next;
    }
    Some(false)
}

fn moov_has_sound<R: Read + Seek>(r: &mut R, start: u64, end: u64, n: &mut u32) -> Option<bool> {
    let mut pos = start;
    let mut tracks = 0;
    while pos < end {
        let (kind, body, next) = read_box(r, pos, end, n)?;
        if &kind == b"trak" {
            tracks += 1;
            if trak_has_sound(r, body, next, n)? {
                return Some(true);
            }
        }
        pos = next;
    }
    // No track list to read (e.g. a compressed QuickTime "cmov"): don't claim
    // "no sound" — unknown lets the browser check decide.
    if tracks == 0 { None } else { Some(false) }
}

/// `Some(true)` when a sound track exists, `Some(false)` when the track list was
/// read and has none, `None` when it isn't an MP4/MOV (or the header is broken).
pub(crate) fn has_sound_track<R: Read + Seek>(r: &mut R) -> Option<bool> {
    let mut n = 0u32;
    let end = r.seek(SeekFrom::End(0)).ok()?;
    let mut pos = 0u64;
    while pos < end {
        let (kind, body, next) = read_box(r, pos, end, &mut n)?;
        if &kind == b"moov" {
            return moov_has_sound(r, body, next, &mut n);
        }
        pos = next;
    }
    None
}

// --- Video start offset ------------------------------------------------------
//
// A browser's timeline zero is the file's time zero, while an editor (Premiere)
// puts the first video frame at clip time 0. When the video's first frame is
// stamped later than 0 (B-frame composition delay, or an edit list that doesn't
// absorb it), "clip time t" must be read at media time `t + offset`, or the
// browser shows the previous frame. The offset is the video track's start time
// (ffprobe's video stream start_time). It is NOT rebased to the first stream:
// measured in the app, a video-only seek proxy that starts at 0.033 s needs the
// same +0.033 s as its original with audio at 0.

/// Up to `n` bytes at `pos` (fewer at the end of the file), or None.
fn rd<R: Read + Seek>(r: &mut R, pos: u64, n: usize) -> Option<Vec<u8>> {
    r.seek(SeekFrom::Start(pos)).ok()?;
    let mut v = Vec::with_capacity(n);
    Read::take(&mut *r, n as u64).read_to_end(&mut v).ok()?;
    if v.is_empty() { None } else { Some(v) }
}

fn be32(v: &[u8], o: usize) -> Option<u32> {
    v.get(o..o + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn be64(v: &[u8], o: usize) -> Option<u64> {
    v.get(o..o + 8).map(|s| u64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}

/// The child boxes of `[start, end)`: `(type, body start, body end)`.
fn children<R: Read + Seek>(r: &mut R, start: u64, end: u64, n: &mut u32) -> Option<Vec<([u8; 4], u64, u64)>> {
    let mut out = Vec::new();
    let mut pos = start;
    while pos < end {
        let (kind, body, next) = read_box(r, pos, end, n)?;
        out.push((kind, body, next));
        pos = next;
    }
    Some(out)
}

fn child<'a>(kids: &'a [([u8; 4], u64, u64)], kind: &[u8; 4]) -> Option<&'a ([u8; 4], u64, u64)> {
    kids.iter().find(|k| &k.0 == kind)
}

/// A timescale field of mvhd/mdhd (same layout): version 0 at +12, version 1 at +20.
fn timescale<R: Read + Seek>(r: &mut R, body: u64) -> Option<u32> {
    let b = rd(r, body, 24)?;
    be32(&b, if b[0] == 1 { 20 } else { 12 })
}

struct Trak {
    id: u32,
    handler: [u8; 4],
    ts: u32,
    /// `(duration in movie units, media_time)`; media_time -1 is an empty edit.
    elst: Vec<(u64, i64)>,
    has_samples: bool,
    /// First composition-time offset in the sample tables.
    ctts0: i64,
}

fn parse_trak<R: Read + Seek>(r: &mut R, start: u64, end: u64, n: &mut u32) -> Option<Trak> {
    let kids = children(r, start, end, n)?;
    let tkhd = child(&kids, b"tkhd")?;
    let t = rd(r, tkhd.1, 24)?;
    let id = be32(&t, if t[0] == 1 { 20 } else { 12 })?;
    let mdia = child(&kids, b"mdia")?;
    let mk = children(r, mdia.1, mdia.2, n)?;
    let ts = timescale(r, child(&mk, b"mdhd")?.1)?;
    let h = rd(r, child(&mk, b"hdlr")?.1 + 8, 4)?;
    let handler = [h[0], h[1], h[2], h[3]];
    let mut elst = Vec::new();
    if let Some(edts) = child(&kids, b"edts") {
        let ek = children(r, edts.1, edts.2, n)?;
        if let Some(e) = child(&ek, b"elst") {
            let ver = rd(r, e.1, 1)?[0];
            let cnt = be32(&rd(r, e.1 + 4, 4)?, 0)? as u64;
            let (step, mut at) = (if ver == 1 { 20u64 } else { 12 }, e.1 + 8);
            for _ in 0..cnt.min(64) {
                let b = rd(r, at, step as usize)?;
                elst.push(if ver == 1 {
                    (be64(&b, 0)?, be64(&b, 8)? as i64)
                } else {
                    (be32(&b, 0)? as u64, be32(&b, 4)? as i32 as i64)
                });
                at += step;
            }
        }
    }
    let (mut has_samples, mut ctts0) = (false, 0i64);
    if let Some(minf) = child(&mk, b"minf") {
        let mf = children(r, minf.1, minf.2, n)?;
        if let Some(stbl) = child(&mf, b"stbl") {
            let sk = children(r, stbl.1, stbl.2, n)?;
            if let Some(s) = child(&sk, b"stts") {
                has_samples = be32(&rd(r, s.1 + 4, 4)?, 0)? > 0;
            }
            if let Some(c) = child(&sk, b"ctts") {
                let b = rd(r, c.1, 16)?;
                if be32(&b, 4)? > 0 {
                    ctts0 = be32(&b, 12)? as i32 as i64;
                }
            }
        }
    }
    Some(Trak { id, handler, ts, elst, has_samples, ctts0 })
}

/// `(base decode time, first sample composition offset)` of a track's first
/// fragment, in its media timescale.
fn first_fragment<R: Read + Seek>(r: &mut R, moofs: &[(u64, u64)], id: u32, n: &mut u32) -> Option<(u64, i64)> {
    for &(start, end) in moofs {
        for traf in children(r, start, end, n)?.into_iter().filter(|k| &k.0 == b"traf") {
            let kids = children(r, traf.1, traf.2, n)?;
            let tfhd = child(&kids, b"tfhd")?;
            if be32(&rd(r, tfhd.1 + 4, 4)?, 0)? != id {
                continue;
            }
            let mut dts = 0u64;
            if let Some(d) = child(&kids, b"tfdt") {
                let b = rd(r, d.1, 12)?;
                dts = if b[0] == 1 { be64(&b, 4)? } else { be32(&b, 4)? as u64 };
            }
            let mut cts = 0i64;
            if let Some(t) = child(&kids, b"trun") {
                let b = rd(r, t.1, 24)?;
                let flags = be32(&b, 0)? & 0x00FF_FFFF;
                if flags & 0x800 != 0 && be32(&b, 4)? > 0 {
                    let mut o = 8;
                    for bit in [0x1u32, 0x4] {
                        if flags & bit != 0 {
                            o += 4;
                        }
                    }
                    for bit in [0x100u32, 0x200, 0x400] {
                        if flags & bit != 0 {
                            o += 4;
                        }
                    }
                    cts = be32(&b, o)? as i32 as i64;
                }
            }
            return Some((dts, cts));
        }
    }
    None
}

/// Seconds at which a track's first sample is presented, on the file's timeline.
fn track_start<R: Read + Seek>(r: &mut R, t: &Trak, movie_ts: u32, moofs: &[(u64, u64)], n: &mut u32) -> f64 {
    if !t.elst.is_empty() {
        // The edit list says where the media lands. Leading empty edits delay the
        // track; a first real edit starting at the first sample (the common
        // case, how encoders absorb the composition delay) does not.
        return t.elst.iter().take_while(|e| e.1 == -1).map(|e| e.0 as f64).sum::<f64>() / movie_ts.max(1) as f64;
    }
    let ticks = if t.has_samples {
        t.ctts0
    } else {
        first_fragment(r, moofs, t.id, n).map(|(dts, cts)| dts as i64 + cts).unwrap_or(0)
    };
    ticks as f64 / t.ts.max(1) as f64
}

/// When the first video frame is stamped, in seconds (>= 0); `None` for anything
/// that isn't an MP4/MOV with a video track.
pub(crate) fn video_start_offset<R: Read + Seek>(r: &mut R) -> Option<f64> {
    let mut n = 0u32;
    let end = r.seek(SeekFrom::End(0)).ok()?;
    let top = children(r, 0, end, &mut n)?;
    let moov = child(&top, b"moov")?;
    let moofs: Vec<(u64, u64)> = top.iter().filter(|k| &k.0 == b"moof").take(64).map(|k| (k.1, k.2)).collect();
    let mk = children(r, moov.1, moov.2, &mut n)?;
    let movie_ts = timescale(r, child(&mk, b"mvhd")?.1)?;
    let mut traks = Vec::new();
    for k in mk.iter().filter(|k| &k.0 == b"trak") {
        if let Some(t) = parse_trak(r, k.1, k.2, &mut n) {
            if &t.handler == b"vide" || &t.handler == b"soun" {
                traks.push(t);
            }
        }
    }
    let video = traks.iter().find(|t| &t.handler == b"vide")?;
    Some(track_start(r, video, movie_ts, &moofs, &mut n).max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// One box: 32-bit size + type + body.
    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(body);
        v
    }
    /// A track whose media handler is `handler` (ISO layout).
    fn trak(handler: &[u8; 4]) -> Vec<u8> {
        let mut h = vec![0u8; 8];
        h.extend_from_slice(handler);
        h.extend_from_slice(&[0u8; 13]);
        bx(b"trak", &bx(b"mdia", &[bx(b"mdhd", &[0u8; 24]), bx(b"hdlr", &h)].concat()))
    }
    fn ftyp() -> Vec<u8> { bx(b"ftyp", b"isom\0\0\x02\0isomiso2avc1mp41") }
    fn check(bytes: Vec<u8>) -> Option<bool> { has_sound_track(&mut Cursor::new(bytes)) }

    #[test]
    fn finds_a_sound_track() {
        let moov = bx(b"moov", &[bx(b"mvhd", &[0u8; 100]), trak(b"vide"), trak(b"soun")].concat());
        assert_eq!(check([ftyp(), moov, bx(b"mdat", &[7u8; 500])].concat()), Some(true));
    }

    #[test]
    fn a_video_without_sound_is_false() {
        assert_eq!(check([ftyp(), bx(b"moov", &trak(b"vide")), bx(b"mdat", &[7u8; 500])].concat()), Some(false));
    }

    #[test]
    fn reads_moov_after_a_large_size_mdat() {
        // size 1 = the real size follows as 64 bits (cameras write mdat this way)
        let mut mdat = 1u32.to_be_bytes().to_vec();
        mdat.extend_from_slice(b"mdat");
        mdat.extend_from_slice(&(16u64 + 1000).to_be_bytes());
        mdat.extend_from_slice(&[7u8; 1000]);
        assert_eq!(check([ftyp(), mdat, bx(b"moov", &[trak(b"vide"), trak(b"soun")].concat())].concat()), Some(true));
    }

    #[test]
    fn a_last_box_with_size_zero_runs_to_the_end() {
        let mut mdat = 0u32.to_be_bytes().to_vec();
        mdat.extend_from_slice(b"mdat");
        mdat.extend_from_slice(&[7u8; 300]);
        assert_eq!(check([ftyp(), bx(b"moov", &trak(b"soun")), mdat].concat()), Some(true));
    }

    #[test]
    fn finds_a_quicktime_sound_handler() {
        let mut h = vec![0u8; 4];
        h.extend_from_slice(b"mhlr");
        h.extend_from_slice(b"soun");
        h.extend_from_slice(&[0u8; 13]);
        let trak = bx(b"trak", &bx(b"mdia", &bx(b"hdlr", &h)));
        assert_eq!(check([bx(b"wide", &[]), bx(b"mdat", &[1u8; 64]), bx(b"moov", &trak)].concat()), Some(true));
    }

    #[test]
    fn a_moov_without_tracks_is_unknown_not_silent() {
        // Old QuickTime can compress the track list ("cmov"): no trak to read, so we
        // can't say "no sound" and must let the browser check decide.
        assert_eq!(check([ftyp(), bx(b"moov", &bx(b"cmov", &[0u8; 40]))].concat()), None);
    }

    #[test]
    fn a_file_without_moov_is_unknown() {
        assert_eq!(check([ftyp(), bx(b"mdat", &[7u8; 500])].concat()), None);
    }

    #[test]
    fn not_an_mp4_is_unknown() {
        // Matroska / WebM start with the EBML magic number
        assert_eq!(check(vec![0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01, 0x42, 0xF7, 0x81]), None);
    }

    #[test]
    fn a_broken_size_is_unknown_not_a_hang() {
        let mut b = ftyp();
        b.extend_from_slice(&4u32.to_be_bytes()); // smaller than its own header
        b.extend_from_slice(b"moov");
        assert_eq!(check(b), None);
    }

    // --- video start offset -------------------------------------------------

    fn u32b(v: u32) -> Vec<u8> { v.to_be_bytes().to_vec() }
    fn full(ver_flags: u32, body: &[u8]) -> Vec<u8> { [u32b(ver_flags), body.to_vec()].concat() }
    fn mvhd(ts: u32) -> Vec<u8> {
        let mut b = vec![0u8; 100];
        b[12..16].copy_from_slice(&ts.to_be_bytes());
        bx(b"mvhd", &b)
    }
    /// A track: handler, media timescale, id, plus any extra boxes (stbl, edts).
    fn tk(handler: &[u8; 4], ts: u32, id: u32, extra: &[Vec<u8>]) -> Vec<u8> {
        let mut h = vec![0u8; 8];
        h.extend_from_slice(handler);
        h.extend_from_slice(&[0u8; 13]);
        let mut mdhd = vec![0u8; 24];
        mdhd[12..16].copy_from_slice(&ts.to_be_bytes());
        let mut tkhd = vec![0u8; 84];
        tkhd[12..16].copy_from_slice(&id.to_be_bytes());
        let mut mdia = vec![bx(b"mdhd", &mdhd), bx(b"hdlr", &h)];
        let mut trak = vec![bx(b"tkhd", &tkhd)];
        let mut stbl = vec![];
        for e in extra {
            if &e[4..8] == b"edts" { trak.push(e.clone()); } else { stbl.push(e.clone()); }
        }
        if !stbl.is_empty() { mdia.push(bx(b"minf", &bx(b"stbl", &stbl.concat()))); }
        trak.push(bx(b"mdia", &mdia.concat()));
        bx(b"trak", &trak.concat())
    }
    fn stts() -> Vec<u8> { bx(b"stts", &full(0, &[u32b(1), u32b(300), u32b(512)].concat())) }
    fn ctts0(offset: u32) -> Vec<u8> { bx(b"ctts", &full(0, &[u32b(1), u32b(1), u32b(offset)].concat())) }
    /// An edit list; `media_time` -1 is an empty edit.
    fn edts(entries: &[(u32, i32)]) -> Vec<u8> {
        let mut b = u32b(entries.len() as u32);
        for (dur, mt) in entries {
            b.extend(u32b(*dur));
            b.extend(mt.to_be_bytes());
            b.extend(u32b(0x0001_0000));
        }
        bx(b"edts", &bx(b"elst", &full(0, &b)))
    }
    /// One fragment for `track_id`: first sample at decode time `dts` with composition offset `cts`.
    fn moof(track_id: u32, dts: u32, cts: u32) -> Vec<u8> {
        let tfhd = bx(b"tfhd", &full(0x0002_0000, &u32b(track_id)));
        let tfdt = bx(b"tfdt", &full(0, &u32b(dts)));
        let trun = bx(b"trun", &full(0x0000_0800, &[u32b(1), u32b(cts)].concat()));
        bx(b"moof", &[bx(b"mfhd", &[0u8; 8]), bx(b"traf", &[tfhd, tfdt, trun].concat())].concat())
    }
    fn offset(bytes: Vec<u8>) -> Option<f64> { video_start_offset(&mut Cursor::new(bytes)) }
    fn close(a: Option<f64>, b: f64) -> bool { a.map_or(false, |a| (a - b).abs() < 1e-6) }

    #[test]
    fn fragmented_video_starting_after_its_audio_is_offset_by_the_gap() {
        // green.mp4's shape: video composition offset 512 @ 15360 = 1/30 s, audio at 0.
        let moov = bx(b"moov", &[mvhd(1000), tk(b"vide", 15360, 1, &[]), tk(b"soun", 44100, 2, &[])].concat());
        let f = [ftyp(), moov, moof(1, 0, 512), moof(2, 0, 0)].concat();
        assert!(close(offset(f), 512.0 / 15360.0));
    }

    #[test]
    fn an_edit_list_that_skips_the_composition_offset_starts_at_zero() {
        // background.mp4's shape: ctts 1024, elst media_time 1024.
        let v = tk(b"vide", 15360, 1, &[stts(), ctts0(1024), edts(&[(10000, 1024)])]);
        let moov = bx(b"moov", &[mvhd(1000), v, tk(b"soun", 44100, 2, &[])].concat());
        assert!(close(offset([ftyp(), moov].concat()), 0.0));
    }

    #[test]
    fn a_video_only_file_is_offset_by_its_own_start() {
        // A seek proxy (`-an`) keeps the original's first-frame time and the
        // browser does not rebase it (measured in the app: frame 60 of the proxy
        // appears at media 2.0345 s, not 2.0 s), so it needs the same shift.
        let moov = bx(b"moov", &[mvhd(1000), tk(b"vide", 15360, 1, &[])].concat());
        assert!(close(offset([ftyp(), moov, moof(1, 0, 507)].concat()), 507.0 / 15360.0));
    }

    #[test]
    fn a_composition_offset_without_an_edit_list_delays_the_video() {
        let v = tk(b"vide", 15360, 1, &[stts(), ctts0(1024)]);
        let moov = bx(b"moov", &[mvhd(1000), v, tk(b"soun", 44100, 2, &[])].concat());
        assert!(close(offset([ftyp(), moov].concat()), 1024.0 / 15360.0));
    }

    #[test]
    fn an_empty_edit_delays_the_video_by_its_movie_timescale_duration() {
        let v = tk(b"vide", 15360, 1, &[stts(), edts(&[(500, -1), (9000, 0)])]);
        let moov = bx(b"moov", &[mvhd(1000), v, tk(b"soun", 44100, 2, &[])].concat());
        assert!(close(offset([ftyp(), moov].concat()), 0.5));
    }

    #[test]
    fn no_video_track_or_not_an_mp4_is_none() {
        let moov = bx(b"moov", &[mvhd(1000), tk(b"soun", 44100, 1, &[])].concat());
        assert_eq!(offset([ftyp(), moov].concat()), None);
        assert_eq!(offset(vec![0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01]), None);
    }
}
