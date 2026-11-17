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
}
