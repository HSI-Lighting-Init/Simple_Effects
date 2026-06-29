// A tiny right-click menu rendered as an absolutely-positioned overlay. Closes
// on the next click / right-click / blur anywhere. Items may carry a `submenu`,
// which flies out to the side on hover (used to pick which box face to map onto).
import { useEffect, useState } from "react";

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
      className="ctx-menu"
      style={{ left: x, top: y }}
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
            {openSub === i && (
              <div className="ctx-flyout">
                {it.submenu.map((s, j) => (
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
                ))}
              </div>
            )}
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
