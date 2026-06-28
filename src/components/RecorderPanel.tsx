// Floating, draggable Session Recorder window.
//
// Start/stop a recording, watch events stream in, then COPY the whole log to the
// clipboard (to paste into a bug report) or save it to a file. Drag it by its
// title bar to move it out of the way.
import { useRef, useState } from "react";
import { currentRecording, recentEvents } from "../lib/recorder";

interface Props {
  recording: boolean;
  /** Bumps on every recorded event — used purely to re-render the live log. */
  recCount: number;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  onClose: () => void;
  onSaveFile: (json: string) => void;
}

function brief(data: unknown): string {
  try {
    const s = JSON.stringify(data, (k, v) => (k === "scene" || k === "project" ? undefined : v));
    return s && s.length > 80 ? s.slice(0, 80) + "…" : s ?? "";
  } catch {
    return "";
  }
}

export default function RecorderPanel({
  recording,
  recCount,
  onStart,
  onStop,
  onClear,
  onClose,
  onSaveFile,
}: Props) {
  const [pos, setPos] = useState({
    x: Math.max(12, window.innerWidth - 380),
    y: 60,
  });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const onHeaderDown = (e: React.MouseEvent) => {
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: Math.min(window.innerWidth - 80, Math.max(0, ev.clientX - dragRef.current.dx)),
        y: Math.min(window.innerHeight - 40, Math.max(0, ev.clientY - dragRef.current.dy)),
      });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const copy = async () => {
    const json = JSON.stringify(currentRecording(), null, 2);
    let ok = false;
    try {
      await navigator.clipboard.writeText(json);
      ok = true;
    } catch {
      // Fallback for webviews that block the async clipboard API.
      const ta = document.createElement("textarea");
      ta.value = json;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
    }
    setCopied(ok);
    setTimeout(() => setCopied(false), 1300);
  };

  // recCount referenced so the live log re-renders as events arrive.
  void recCount;
  const events = recentEvents(120);

  return (
    <div className="rec-panel" style={{ left: pos.x, top: pos.y }}>
      <div className="rec-head" onMouseDown={onHeaderDown}>
        <span className={"rec-dot" + (recording ? " on" : "")} />
        <span className="rec-title">Session Recorder</span>
        <span className="rec-count">{events.length ? `${currentRecording().eventCount} events` : ""}</span>
        <button className="rec-x" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="rec-controls">
        {recording ? (
          <button className="rec-btn stop" onClick={onStop}>
            ■ Stop
          </button>
        ) : (
          <button className="rec-btn start" onClick={onStart}>
            ● Record
          </button>
        )}
        <button className="rec-btn" onClick={copy} title="Copy the whole log as JSON">
          {copied ? "✓ Copied" : "⧉ Copy"}
        </button>
        <button
          className="rec-btn"
          onClick={() => onSaveFile(JSON.stringify(currentRecording(), null, 2))}
          title="Save the log to a .json file"
        >
          ⤓ Save
        </button>
        <button className="rec-btn" onClick={onClear} title="Discard recorded events">
          Clear
        </button>
      </div>

      <div className="rec-log">
        {events.length === 0 ? (
          <div className="rec-empty">
            {recording ? "Recording… interact with the app." : "Press ● Record, reproduce the bug, then ⧉ Copy and paste it to the dev."}
          </div>
        ) : (
          events
            .slice()
            .reverse()
            .map((e, i) => (
              <div className="rec-row" key={events.length - i}>
                <span className="rec-t">+{e.tMs}ms</span>
                <span className={"rec-type t-" + e.type}>{e.type}</span>
                <span className="rec-data">{brief(e.data)}</span>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
