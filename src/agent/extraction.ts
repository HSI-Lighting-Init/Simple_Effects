// Phase 7 roadmap item 1 ("production path for the Claude steps... through
// the app's own runtime model"): the two template-decomposition submission
// tools - per-shot SAM3 concept phrasings, and per-key-frame text-line
// reading. The VISION work itself is NOT done here or by the app - it's
// done by whichever AI agent is driving the app over the MCP bridge (this
// is the same "the app exposes tools, an external agent supplies the
// intelligence" shape every other DEV ONLY tool already uses - analyze_
// reference measures, but "read text content" is explicitly left to the
// caller; match_transition scores candidates the caller already rendered).
// generate_phrasings/read_text_lines are that same shape: the caller looks
// at the shot's own key-frame images directly (the same vision access used
// throughout this session, e.g. via the Read tool) and submits the result
// through these tools instead of a dev-session script hand-writing JSON -
// no Anthropic key, no billed call, no app-side inference. What the app
// DOES own is PERSISTING the submission into the exact phrasings.json/
// text_lines.json shape sam/phase3_core.py already consumes (so this is a
// real drop-in replacement for the ad-hoc dev workflow, not a parallel
// format), via a read-merge-write on a caller-given output path, plus a
// durable JSONL audit trail of what was submitted and when.
import { readTextFile, writeTextFile, appendTextFile } from "../lib/api";

export interface ElementTypePhrasing {
  type: string;
  phrasings: string[];
}

export interface TextLineReading {
  /** [x0, y0, x1, y1] as fractions (0..1) of the frame's own width/height -
   *  matches track_text_lines' own expected shape in sam/phase3_core.py
   *  (`fx0, fy0, fx1, fy1 = tl["box"]`, multiplied by the REAL frame size
   *  there, not re-derived from a fixed analysis resolution). */
  box: [number, number, number, number];
  content: string;
  role: "headline" | "label" | "logo wordmark" | "other";
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  const text = await readTextFile(path);
  return text ? (JSON.parse(text) as T) : fallback;
}

/** Merge one shot's element-type phrasings into the phrasings.json-shaped
 *  file at `outPath` ({[shotName]: ElementTypePhrasing[]}), creating it if
 *  needed, then appends one audit-trail line. Overwrites any prior entry
 *  for this exact shot (a resubmit replaces, doesn't duplicate). */
export async function submitPhrasings(outPath: string, shotName: string, elementTypes: ElementTypePhrasing[]): Promise<void> {
  const all = await readJson<Record<string, ElementTypePhrasing[]>>(outPath, {});
  all[shotName] = elementTypes;
  await writeTextFile(outPath, JSON.stringify(all, null, 2));
  await logSubmission("generate_phrasings", shotName, { elementTypes });
}

/** Merge one key frame's text-line readings into the text_lines.json-shaped
 *  file at `outPath` ({[shotName]: {idx, box, content, role}[]}), creating
 *  it if needed. `frameIdx` tags every line from this submission and first
 *  removes any PRIOR lines already tagged with that same frameIdx (a
 *  resubmit for one frame replaces just that frame's own lines, leaving
 *  every other frame's already-submitted lines untouched). */
export async function submitTextLines(outPath: string, shotName: string, frameIdx: number, textLines: TextLineReading[]): Promise<void> {
  const all = await readJson<Record<string, (TextLineReading & { idx: number })[]>>(outPath, {});
  const existing = (all[shotName] ?? []).filter((tl) => tl.idx !== frameIdx);
  all[shotName] = [...existing, ...textLines.map((tl) => ({ ...tl, idx: frameIdx }))];
  await writeTextFile(outPath, JSON.stringify(all, null, 2));
  await logSubmission("read_text_lines", `${shotName} frame ${frameIdx}`, { frameIdx, textLines });
}

async function logSubmission(tool: string, label: string, data: unknown): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), tool, label, ...((data ?? {}) as object) });
  // Same app-local-data-dir convention as autosave/checkpoints (App.tsx) -
  // resolved lazily here to avoid a circular import on App.tsx itself.
  const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
  const path = await join(await appLocalDataDir(), "extraction_submissions.jsonl");
  await appendTextFile(path, line);
}
