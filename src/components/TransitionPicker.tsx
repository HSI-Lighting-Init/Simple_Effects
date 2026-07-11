// A searchable, scrollable modal for choosing a transition from the full library.
// Replaces the deeply-nested right-click flyouts (which ran off-screen / under the
// taskbar). Always centred on screen, filterable, grouped by category.
import { useMemo, useState } from "react";
import { REGISTRY } from "../lib/transitions";

const CATS: { category: string; items: { id: string; label: string }[] }[] = (() => {
  const groups: { category: string; items: { id: string; label: string }[] }[] = [];
  for (const m of REGISTRY) {
    let g = groups.find((x) => x.category === m.category);
    if (!g) groups.push((g = { category: m.category, items: [] }));
    g.items.push({ id: m.id, label: m.label });
  }
  return groups;
})();

export default function TransitionPicker({
  title,
  onPick,
  onClose,
}: {
  title: string;
  /** null clears the transition; a string is the engine id. */
  onPick: (engine: string | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const groups = useMemo(
    () =>
      CATS.map((c) => ({
        category: c.category,
        items: query ? c.items.filter((it) => it.label.toLowerCase().includes(query)) : c.items,
      })).filter((g) => g.items.length > 0),
    [query]
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal tpick-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div className="modal-body">
          <input
            autoFocus
            className="insp-text"
            placeholder="Search transitions…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="insp-btn" style={{ marginTop: 6 }} onClick={() => onPick(null)}>
            None (clear transition)
          </button>
          <div className="tpick-list">
            {groups.map((g) => (
              <div key={g.category}>
                <div className="tpick-cat">{g.category}</div>
                {g.items.map((it) => (
                  <button key={it.id} className="tpick-item" onClick={() => onPick(it.id)}>
                    {it.label}
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && <div className="muted" style={{ padding: 8 }}>No matches</div>}
          </div>
        </div>
        <div className="modal-actions">
          <button className="insp-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
