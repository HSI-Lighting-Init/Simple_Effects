// A tiny right-click menu rendered as an absolutely-positioned overlay. Closes
// on the next click / right-click / blur anywhere. Items may carry a `submenu`,
// which flies out to the side on hover (used to pick which box face to map onto).
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onClick?: () => void;
  submenu?: MenuItem[];
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Start at the click point; after measuring, clamp so the whole menu stays
  // within the viewport (fixed-position menus can't be scrolled into view, so a
  // menu opened near the bottom/right edge would otherwise be cut off).
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const margin = 6;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    // Prefer opening down/right; if it would overflow, flip to above/left of the
    // cursor, then clamp so it never leaves the viewport.
    if (left + width > vw - margin) left = Math.max(margin, x - width);
    if (top + height > vh - margin) top = Math.max(margin, y - height);
    left = Math.min(left, vw - width - margin);
    top = Math.min(top, vh - height - margin);
    left = Math.max(margin, left);
    top = Math.max(margin, top);
    setPos({ left, top });
  }, [x, y, items]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((it, i) =>
        it.submenu ? (
          <div
            key={i}
            className="ctx-sub"
            onMouseEnter={() => setOpenSub(i)}
            onMouseLeave={() => setOpenSub((cur) => (cur === i ? null : cur))}
          >
            <button className="ctx-item ctx-item-parent">
              <span>{it.label}</span>
              <span className="ctx-arrow">▸</span>
            </button>
            {openSub === i && <Flyout items={it.submenu} onClose={onClose} />}
          </div>
        ) : (
          <button
            key={i}
            className="ctx-item"
            onClick={() => {
              it.onClick?.();
              onClose();
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>
  );
}

// A submenu flyout that nudges itself vertically so it never spills past the
// bottom of the viewport, and flips to the left of its parent if it would spill
// past the right edge. Recursive: items may themselves carry a `submenu`.
function Flyout({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const [flip, setFlip] = useState(false);
  const [openSub, setOpenSub] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 6;
    const rect = el.getBoundingClientRect();
    const overflow = rect.bottom - (window.innerHeight - margin);
    if (overflow > 0) setShift(-Math.min(overflow, rect.top - margin));
    else setShift(0);
    setFlip(rect.right > window.innerWidth - margin);
  }, [items]);

  return (
    <div
      className={"ctx-flyout" + (flip ? " ctx-flyout-left" : "")}
      ref={ref}
      style={{ marginTop: shift }}
    >
      {items.map((s, j) =>
        s.submenu ? (
          <div
            key={j}
            className="ctx-sub"
            onMouseEnter={() => setOpenSub(j)}
            onMouseLeave={() => setOpenSub((cur) => (cur === j ? null : cur))}
          >
            <button className="ctx-item ctx-item-parent">
              <span>{s.label}</span>
              <span className="ctx-arrow">▸</span>
            </button>
            {openSub === j && <Flyout items={s.submenu} onClose={onClose} />}
          </div>
        ) : (
          <button
            key={j}
            className="ctx-item"
            onClick={() => {
              s.onClick?.();
              onClose();
            }}
          >
            {s.label}
          </button>
        )
      )}
    </div>
  );
}
