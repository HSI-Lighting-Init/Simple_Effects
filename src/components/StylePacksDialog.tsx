// Style Packs: pick a complete look (Instagram Block, News Studio, Traveller's
// Choice…) and apply it to the whole timeline. Describing the video highlights the
// best-matching pack. Applying saves a checkpoint first, so Revert is one click.
import { useMemo, useState } from "react";
import type { Rgba } from "../bindings/Rgba";
import { STYLE_PACKS, matchStyles, type StylePack, type StyleResult } from "../lib/stylePacks";

const css = (c: Rgba) => `rgba(${c.r},${c.g},${c.b},${c.a / 255})`;

export default function StylePacksDialog({
  onApply,
  onRevert,
  onClose,
}: {
  onApply: (id: string) => Promise<StyleResult>;
  onRevert: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [describe, setDescribe] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [applied, setApplied] = useState(false);

  const best = useMemo(() => {
    const [top] = matchStyles(describe);
    return top && top.score > 0 ? top.pack.id : null;
  }, [describe]);
  const groups = useMemo(() => {
    const m = new Map<string, StylePack[]>();
    for (const p of STYLE_PACKS) m.set(p.category, [...(m.get(p.category) ?? []), p]);
    return [...m.entries()];
  }, []);

  const apply = async (p: StylePack) => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await onApply(p.id);
      setApplied(true);
      setStatus({
        ok: true,
        text: `Applied ${r.style}: ${r.clips} clip${r.clips === 1 ? "" : "s"}, ${r.titles} title${r.titles === 1 ? "" : "s"} · transitions ${r.transitions.join(", ") || "—"}${r.overlays.length ? ` · overlays ${r.overlays.join(", ")}` : ""}.`,
      });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    setBusy(true);
    try {
      const done = await onRevert();
      setStatus({ ok: done, text: done ? "Reverted to before the last style." : "No style checkpoint to revert to." });
      if (done) setApplied(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="modal-box scenario-panel" style={{ width: 760, maxWidth: "95vw", maxHeight: "90vh", overflowY: "auto" }} onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="modal-title">🎨 Style Packs</h3>
        <p className="insp-hint" style={{ marginTop: 0 }}>
          A style pack sets the whole look in one click: transitions on every cut, color grade, Ken Burns motion, overlays, and title styling. It
          replaces the effects and in-transitions on your clips; a checkpoint is saved first so you can revert.
        </p>
        <input
          style={{ width: "100%", boxSizing: "border-box" }}
          placeholder="Describe your video to find a match — e.g. 'upbeat instagram promo for a lighting brand'"
          value={describe}
          onChange={(e) => setDescribe(e.target.value)}
          disabled={busy}
        />

        {groups.map(([category, packs]) => (
          <div key={category}>
            <div className="insp-sep">{category}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 8 }}>
              {packs.map((p) => (
                <div
                  key={p.id}
                  style={{
                    border: `1px solid ${best === p.id ? "var(--accent)" : "var(--line)"}`,
                    boxShadow: best === p.id ? "0 0 0 1px var(--accent)" : undefined,
                    borderRadius: 6,
                    padding: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ display: "flex", gap: 3 }}>
                      {p.palette.map((c, i) => (
                        <span key={i} style={{ width: 14, height: 14, borderRadius: 3, background: css(c), border: "1px solid rgba(255,255,255,0.25)" }} />
                      ))}
                    </div>
                    <strong style={{ flex: 1 }}>{p.name}</strong>
                    {best === p.id && <span style={{ fontSize: 11, color: "var(--accent)" }}>best match</span>}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.4 }}>{p.description}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 11, opacity: 0.6 }}>~{(p.shotMs / 1000).toFixed(1)}s per shot</span>
                    <button className="insp-btn active" onClick={() => void apply(p)} disabled={busy}>
                      Apply
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {status && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 10px",
              borderRadius: 4,
              fontSize: 13,
              background: status.ok ? "rgba(46,204,113,0.16)" : "rgba(231,76,60,0.16)",
              color: status.ok ? "#7ee2a8" : "#ff9b8f",
            }}
          >
            {status.ok ? "✓ " : "✕ "}
            {status.text}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 12 }}>
          {applied && (
            <button className="insp-btn" onClick={() => void revert()} disabled={busy}>
              ↶ Revert
            </button>
          )}
          <button className="insp-btn" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
