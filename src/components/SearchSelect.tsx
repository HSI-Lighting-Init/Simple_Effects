// A searchable dropdown (combobox) with per-namespace favourites. Used for the
// effect and transition pickers so the user can type to filter and star up to 10
// favourites (kept at the top). Favourites persist in localStorage.
//
// The popup is rendered through a portal to <body> with fixed positioning
// (anchored to the button) so it's never clipped by the inspector's scroll area
// or a collapsible section's `overflow: hidden`.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SelItem {
  id: string;
  label: string;
}
export interface SelGroup {
  category: string;
  items: SelItem[];
}

const FAV_MAX = 10;
const favStore = (ns: string) => `sefx.fav.${ns}`;

function readFavs(ns: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(favStore(ns)) || "[]");
    return Array.isArray(v) ? (v as string[]).slice(0, FAV_MAX) : [];
  } catch {
    return [];
  }
}
function writeFavs(ns: string, ids: string[]) {
  try {
    localStorage.setItem(favStore(ns), JSON.stringify(ids.slice(0, FAV_MAX)));
  } catch {
    /* ignore quota / unavailable */
  }
}

function Row({
  it,
  fav,
  active,
  onChoose,
  onToggleFav,
}: {
  it: SelItem;
  fav: boolean;
  active: boolean;
  onChoose: (id: string) => void;
  onToggleFav: (id: string) => void;
}) {
  return (
    <div className={"ss-row" + (active ? " active" : "")}>
      <button
        className={"ss-star" + (fav ? " on" : "")}
        title={fav ? "Remove favourite" : "Add favourite"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFav(it.id);
        }}
      >
        {fav ? "★" : "☆"}
      </button>
      <button className="ss-item" onClick={() => onChoose(it.id)}>
        {it.label}
      </button>
    </div>
  );
}

export default function SearchSelect({
  value,
  groups,
  onChange,
  favKey,
  placeholder = "Select…",
  buttonLabel,
}: {
  /** Currently selected id (highlighted). */
  value: string;
  groups: SelGroup[];
  onChange: (id: string) => void;
  /** localStorage namespace for this picker's favourites. */
  favKey: string;
  placeholder?: string;
  /** Fixed button text (action mode, e.g. "＋ Add effect…"); else shows value. */
  buttonLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [favs, setFavs] = useState<string[]>(() => readFavs(favKey));
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Fixed-position box for the portalled popup (anchored to the button).
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number }>({
    left: 0,
    top: 0,
    width: 0,
    maxH: 320,
  });

  const allItems = groups.flatMap((g) => g.items);
  const current = allItems.find((i) => i.id === value);
  const label = buttonLabel ?? current?.label ?? placeholder;

  // Position the popup under (or above) the button, in viewport coords. Opens
  // upward when there isn't enough room below.
  const place = () => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const gap = 4;
    const spaceBelow = window.innerHeight - r.bottom - gap;
    const spaceAbove = r.top - gap;
    const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
    const maxH = Math.max(160, Math.min(340, Math.round(openUp ? spaceAbove : spaceBelow)));
    const top = openUp ? Math.max(gap, r.top - gap - maxH) : r.bottom + gap;
    setPos({ left: Math.round(r.left), top: Math.round(top), width: Math.round(r.width), maxH });
  };

  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        rootRef.current && !rootRef.current.contains(t) &&
        popRef.current && !popRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // Keep the popup pinned to the button as the inspector (or window) scrolls.
    const reposition = () => place();
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleFav = (id: string) =>
    setFavs((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur].slice(0, FAV_MAX);
      writeFavs(favKey, next);
      return next;
    });

  const ql = q.trim().toLowerCase();
  const match = (it: SelItem) => !ql || it.label.toLowerCase().includes(ql);
  const favItems = favs
    .map((id) => allItems.find((i) => i.id === id))
    .filter((it): it is SelItem => !!it)
    .filter(match);

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="ss-root" ref={rootRef}>
      <button ref={btnRef} className="ss-btn" onClick={() => setOpen((o) => !o)} title={label}>
        <span className="ss-btn-label">{label}</span>
        <span className="ss-caret">▾</span>
      </button>
      {open &&
        createPortal(
          <div
            className="ss-pop"
            ref={popRef}
            style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxH }}
          >
            <input
              autoFocus
              className="ss-search"
              placeholder="Search…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          <div className="ss-list">
            {favItems.length > 0 && (
              <div className="ss-group">
                <div className="ss-group-title">★ Favourites</div>
                {favItems.map((it) => (
                  <Row
                    key={"fav-" + it.id}
                    it={it}
                    fav
                    active={it.id === value}
                    onChoose={choose}
                    onToggleFav={toggleFav}
                  />
                ))}
              </div>
            )}
            {groups.map((g) => {
              const items = g.items.filter(match);
              if (!items.length) return null;
              return (
                <div className="ss-group" key={g.category}>
                  <div className="ss-group-title">{g.category}</div>
                  {items.map((it) => (
                    <Row
                      key={it.id}
                      it={it}
                      fav={favs.includes(it.id)}
                      active={it.id === value}
                      onChoose={choose}
                      onToggleFav={toggleFav}
                    />
                  ))}
                </div>
              );
            })}
            {allItems.filter(match).length === 0 && <div className="ss-empty">No matches</div>}
          </div>
          </div>,
          document.body
        )}
    </div>
  );
}
