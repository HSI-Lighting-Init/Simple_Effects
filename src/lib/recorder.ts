// Session recorder — a dev tool for capturing bug repros.
//
// While active it timestamps a log of: clicks (coords + what was hit), app
// actions (select / move / scale / keyframe / text edit / preset / play / seek /
// undo / redo), a scene snapshot at each event (every layer's X/Y/scale/rotation/
// opacity + image src / text content), JS errors, and window resizes. Because the
// Rust evaluator is deterministic, the captured project + action log reproduces
// any frame exactly. Stop → the whole thing is saved as JSON.

export interface RecEvent {
  /** ms since recording started. */
  tMs: number;
  /** ISO wall-clock time. */
  at: string;
  type: string;
  data: unknown;
}

export interface Recording {
  meta: Record<string, unknown>;
  eventCount: number;
  events: RecEvent[];
}

let active = false;
let events: RecEvent[] = [];
let startPerf = 0;
let meta: Record<string, unknown> = {};

export function isRecording(): boolean {
  return active;
}

export function startRecording(metaInfo: Record<string, unknown>): void {
  active = true;
  events = [];
  startPerf = performance.now();
  meta = { startedAt: new Date().toISOString(), userAgent: navigator.userAgent, ...metaInfo };
}

export function record(type: string, data: unknown = {}): void {
  if (!active) return;
  events.push({
    tMs: Math.round(performance.now() - startPerf),
    at: new Date().toISOString(),
    type,
    data,
  });
}

export function eventCount(): number {
  return events.length;
}

export function stopRecording(): Recording {
  active = false;
  meta = { ...meta, endedAt: new Date().toISOString() };
  return currentRecording();
}

/** The current recording WITHOUT stopping — for the live panel + copy/save. */
export function currentRecording(): Recording {
  return {
    meta: { ...meta, snapshotAt: new Date().toISOString() },
    eventCount: events.length,
    events: [...events],
  };
}

/** The most recent events (newest last), for the live log view. */
export function recentEvents(limit: number): RecEvent[] {
  return events.slice(Math.max(0, events.length - limit));
}

/** Discard the current recording's events. */
export function clearRecording(): void {
  events = [];
}

/** A short human-readable description of a clicked element, for the click log. */
export function describeTarget(el: Element | null): string {
  if (!el) return "unknown";
  const btn = el.closest("button");
  if (btn) return `button:"${(btn.textContent || "").trim()}"`;
  if (el.tagName === "CANVAS") return "canvas(stage)";
  const region = el.closest(
    ".timeline, .inspector, .toolbar, .tl-tracks, .tl-label, .preview-wrap, .stage-area"
  );
  const regionName =
    region && typeof region.className === "string" ? region.className.split(" ")[0] : "";
  const cls = typeof el.className === "string" && el.className ? "." + el.className.split(" ")[0] : "";
  return `${el.tagName.toLowerCase()}${cls}${regionName ? " @" + regionName : ""}`;
}
