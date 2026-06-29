// A classic application menu bar (File, Edit, …). Click a title to open its
// dropdown; once one is open, hovering the others switches to them. Click an
// item to run it; click anywhere outside to close.
import { useEffect, useRef, useState } from "react";

export interface MenuItemDef {
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
  shortcut?: string;
}

export interface MenuDef {
  title: string;
  items: MenuItemDef[];
}

export default function MenuBar({ menus }: { menus: MenuDef[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open == null) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className="menubar" ref={barRef}>
      {menus.map((m, i) => (
        <div key={m.title} className="menu">
          <button
            className={"menu-title" + (open === i ? " open" : "")}
            onClick={() => setOpen(open === i ? null : i)}
            onMouseEnter={() => {
              if (open != null) setOpen(i);
            }}
          >
            {m.title}
          </button>
          {open === i && (
            <div className="menu-drop">
              {m.items.map((it, j) =>
                it.separator ? (
                  <div key={j} className="menu-sep" />
                ) : (
                  <button
                    key={j}
                    className="menu-item"
                    disabled={it.disabled}
                    onClick={() => {
                      setOpen(null);
                      it.onClick?.();
                    }}
                  >
                    <span>{it.label}</span>
                    {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
