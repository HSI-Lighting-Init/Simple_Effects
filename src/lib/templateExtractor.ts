// Phase 7: "drop a video, get a template" - the autonomous end-to-end flow.
// Unlike sam/phase3_core.py (a dev-session script) or src/agent/extraction.ts
// (the MCP-bridge-driven dev tools, where an external AI agent supplies the
// vision analysis), this runs with NO external agent attached: a normal end
// user dropping a video into the app. So the vision steps (phrasings/text
// reading) use the app's own BYOK Anthropic key here (providers.ts's
// extractFromImages, the same key ScenarioPanel already asks for) - the
// opposite of extraction.ts's own design, and deliberately so; see
// extractFromImages's own doc for why both exist and when each applies.
//
// Orchestrates, per shot: extract_shot_clip -> sam_service's own
// /detect_keyframes -> phrasings (one vision call per shot, all its key
// frames at once) + text lines (one vision call per key frame) ->
// /process_shot + /process_text_lines (SAM3 detect, SAM2 track, cross-
// key-frame dedup, mask-shape fit - all server-side, returning RAW
// unfitted samples) -> this app's own real fit_background Tauri command,
// called directly via invoke() (no MCP bridge involved anywhere in this
// file) -> assembled into the SAME ShotAnalysis.elements[] shape Gate C's
// own rebuildFromAnalysis.ts extension already consumes -> rebuildFromAnalysis.
//
// REPLACEMENT, not reconstruction - the one place this deliberately diverges
// from Gate C's own build_gate_c.py: Gate C's whole point was proving the
// pipeline faithfully rebuilds the ORIGINAL reel (sprites for still cards,
// the original clip for footage cards). Phase 7's whole point is the
// opposite - applying the reference's measured STRUCTURE (box/motion/
// timing) to the USER's OWN newMedia instead. So every detected card
// element here gets the next item from newMedia (same cycling convention
// rebuildFromAnalysis's own default path already uses), not a sprite or the
// source clip - the sam_service's own still-vs-footage classification
// (and the sprite PNG it computes) is simply unused in this file, not
// because it's wrong, but because this is a different job than Gate C's.
//
// A shot where SAM found zero trackable elements gets NO `elements` field at
// all, not an empty array - rebuildFromAnalysis's own existing dispatch
// (elements path only when `shot.elements` is non-empty) then falls through
// to its ORIGINAL single-cover-fit-image path using that shot's own
// analyze_reference-measured motion/look/fades, for free.
import { analyzeReference, extractShotClip, fitBackground, loadImageDataUrl } from "./api";
import { extractFromImages } from "../agent/providers";
import { rebuildFromAnalysis, type ElementLayer, type RebuildIO, type RebuildResult, type ShotAnalysis, type TemplateAnalysis } from "./rebuildFromAnalysis";
import { join } from "@tauri-apps/api/path";

const SAM_SERVICE_BASE = (port: number) => `http://127.0.0.1:${port}`;

async function samCall<T>(port: number, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SAM_SERVICE_BASE(port)}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`sam_service ${path} failed: ${json.error ?? res.statusText}`);
  return json as T;
}

interface ElementTypePhrasing {
  type: string;
  phrasings: string[];
}
interface TextLineReading {
  box: [number, number, number, number];
  content: string;
  role: "headline" | "label" | "logo wordmark" | "other";
}
type RawSample = { tMs: number; scale: number; rotationDeg: number; tx: number; ty: number; solved: boolean };
/** Raw per-element data sam_service's own /process_shot returns - "raw"
 *  meaning `samples` is unfitted AlignSample[], not yet keyed down (see
 *  this module's own header doc for why the fitting step happens here, not
 *  inside the service). `kind`/`spritePngBase64` are present in the
 *  response (sam_service always computes them) but unused here - see this
 *  module's own "REPLACEMENT, not reconstruction" doc. */
interface RawSamElement {
  concept: string;
  kind: "still" | "footage" | "unknown";
  refBbox: [number, number, number, number] | null;
  refCentroid: [number, number] | null;
  samples: RawSample[] | null;
  startMs: number | null;
  endMs: number | null;
}
interface RawSamTextElement {
  kind: "box" | "mask";
  concept: string;
  box?: [number, number, number, number];
  refBbox?: [number, number, number, number] | null;
  refCentroid?: [number, number] | null;
  samples?: RawSample[] | null;
  startMs?: number | null;
  endMs?: number | null;
}

const PHRASINGS_SCHEMA = {
  type: "object",
  properties: {
    elementTypes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", description: "short name for this kind of element, e.g. 'photo', 'logo'" },
          phrasings: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 3,
            description: "2-3 varied short noun phrases a text-grounded object detector can match against this element type - always include one plain, literal noun (e.g. 'photo', 'picture'). Never use the bare word 'card' alone - it reliably fails to match even visually obvious cards.",
          },
        },
        required: ["type", "phrasings"],
        additionalProperties: false,
      },
    },
  },
  required: ["elementTypes"],
  additionalProperties: false,
} as const;

const PHRASINGS_SYSTEM = `You are looking at key frames from one shot of a motion-graphics video template. Identify the DISTINCT VISUAL ELEMENT TYPES in this shot that are worth tracking as separate, reusable template elements when this template gets rebuilt with different media - typically photo/image cards and logo/wordmark graphics. Do not list every visual detail (decorative dots, background patterns, generic text) - only things a template-rebuild tool would need to place and animate as its own element. For each distinct element TYPE (not each individual instance - "photo" covers every photo card in the shot, even if there are five), write 2-3 varied phrasings a text-grounded object detector (SAM3) can match. Always include one plain, literal noun. Never use the bare word "card" alone - it reliably fails to match even visually obvious torn-paper photo cards. If this shot has no trackable image/logo elements (e.g. it's pure text/background), return an empty elementTypes array - do not invent one to avoid an empty answer.`;

const TEXT_LINES_SCHEMA = {
  type: "object",
  properties: {
    textLines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          box: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[x0, y0, x1, y1] as fractions (0..1) of this frame's own width/height - a TIGHT box around just the visible glyphs." },
          content: { type: "string", description: "the exact text as it appears right now - if mid-reveal/partially occluded, transcribe only what's actually visible, don't guess the full word." },
          role: { type: "string", enum: ["headline", "label", "logo wordmark", "other"] },
        },
        required: ["box", "content", "role"],
        additionalProperties: false,
      },
    },
  },
  required: ["textLines"],
  additionalProperties: false,
} as const;

const TEXT_LINES_SYSTEM = `You are looking at one frame from a motion-graphics video. Read every visible line of text in this exact frame. For each line give a TIGHT bounding box as fractions (0..1) of the frame's own width/height, the exact text content as it appears right now (if a kinetic-type animation means only part of a word is visible, transcribe only that visible part), and a role: "headline" (the main large title text), "label" (smaller secondary text, including small recurring tags/chips), "logo wordmark" (a brand/logo name treated as a graphic, not body copy), or "other". If there's no text visible in this frame, return an empty textLines array.`;

export interface ExtractTemplateOptions {
  referenceVideoPath: string;
  /** Replacement media (images/videos) placed into the reference's own
   *  measured card slots, cycling if there are fewer items than cards
   *  found across the whole reference (same convention rebuildFromAnalysis's
   *  own default path already uses) - NOT the original reference content. */
  newMedia: string[];
  outPath: string;
  apiKey: string;
  model: string;
  /** Scratch dir for intermediate per-shot clips/key-frame images - not
   *  part of the final project, safe to delete once this resolves. */
  workDir: string;
  samServicePort?: number;
  onProgress?: (message: string) => void;
}

function parseConcept(concept: string): string {
  const i = concept.indexOf(": ");
  return i === -1 ? concept : concept.slice(i + 2);
}

async function fitRawSamples(samples: RawSample[] | null | undefined, startMs: number | null | undefined, endMs: number | null | undefined) {
  if (!samples || startMs == null || endMs == null) return undefined;
  return fitBackground(samples, startMs, endMs);
}

/** Build one shot's card ElementLayer[]s, assigning each a NEXT item from
 *  the shared newMedia cursor (see this module's own "REPLACEMENT, not
 *  reconstruction" doc) and fitting its raw samples via this app's own real
 *  fit_background. "unknown"-kind detections (no usable fit at all) are
 *  dropped, not faked - same policy Gate C's own build_gate_c.py already
 *  established. */
async function buildCardElements(objects: RawSamElement[], nextMediaIndex: () => number): Promise<ElementLayer[]> {
  const elements: ElementLayer[] = [];
  for (const obj of objects) {
    if (obj.kind === "unknown" || !obj.refBbox || obj.startMs == null || obj.endMs == null) continue;
    const fittedMotion = await fitRawSamples(obj.samples, obj.startMs, obj.endMs);
    elements.push({
      kind: "stillCard", // functionally identical to "footageCard" in buildShotElements - the actual media file (image or video) decides the real layer kind, this label is cosmetic
      mediaIndex: nextMediaIndex(),
      startMs: obj.startMs,
      endMs: obj.endMs,
      refBbox: obj.refBbox,
      refCentroid: obj.refCentroid ?? undefined,
      fittedMotion,
    });
  }
  return elements;
}

/** Build one shot's text ElementLayer[]s from sam_service's own grouped/
 *  deduped text objects - unlike cards, text keeps its OWN detected content
 *  (no newMedia substitution; replacing copy isn't this flow's job). */
async function buildTextElements(objects: RawSamTextElement[], shotDurMs: number): Promise<ElementLayer[]> {
  const elements: ElementLayer[] = [];
  for (const tobj of objects) {
    const content = parseConcept(tobj.concept);
    if (tobj.kind === "mask") {
      if (!tobj.refBbox || tobj.startMs == null || tobj.endMs == null) continue;
      const fittedMotion = await fitRawSamples(tobj.samples, tobj.startMs, tobj.endMs);
      elements.push({ kind: "text", content, startMs: tobj.startMs, endMs: tobj.endMs, refBbox: tobj.refBbox, refCentroid: tobj.refCentroid ?? undefined, fittedMotion });
    } else if (tobj.box) {
      const [x0, y0, x1, y1] = tobj.box;
      elements.push({ kind: "text", content, startMs: 0, endMs: shotDurMs, refBbox: tobj.box, refCentroid: [(x0 + x1) / 2, (y0 + y1) / 2] });
    }
  }
  return elements;
}

/** The autonomous end-to-end extraction: analyze the reference, split it
 *  into shots, run the full per-shot pipeline (keyframes -> phrasings/text
 *  vision calls -> SAM detect/track/dedup -> fit), assemble a
 *  TemplateAnalysis, and rebuild with newMedia. */
export async function extractTemplate(io: RebuildIO, opts: ExtractTemplateOptions): Promise<RebuildResult> {
  if (!opts.newMedia.length) throw new Error("extractTemplate: newMedia is empty");
  const port = opts.samServicePort ?? 8799;
  const log = opts.onProgress ?? (() => {});

  log("Analyzing reference video...");
  const analysis = await analyzeReference(opts.referenceVideoPath);
  const shots: ShotAnalysis[] = [];
  let mediaCursor = 0;
  const nextMediaIndex = () => mediaCursor++ % opts.newMedia.length;

  for (const [i, shot] of analysis.shots.entries()) {
    log(`Shot ${i + 1}/${analysis.shots.length}: extracting clip...`);
    const shotClipPath = await join(opts.workDir, `shot_${i}.mp4`);
    await extractShotClip(opts.referenceVideoPath, shot.startMs, shot.endMs, shotClipPath);

    log(`Shot ${i + 1}/${analysis.shots.length}: detecting key frames...`);
    const framesDir = await join(opts.workDir, "frames");
    const kf = await samCall<{ numFrames: number; keyFrames: number[]; framePaths: string[] }>(port, "/detect_keyframes", {
      videoPath: shotClipPath,
      framesOutDir: framesDir,
    });

    log(`Shot ${i + 1}/${analysis.shots.length}: reading phrasings + text (${kf.keyFrames.length} key frames)...`);
    const phrasingImages = await Promise.all(kf.framePaths.map(loadImageDataUrl));
    const { result: phrasingsResult } = await extractFromImages<{ elementTypes: ElementTypePhrasing[] }>(
      opts.apiKey, opts.model, PHRASINGS_SYSTEM, `${phrasingImages.length} key frame(s) from this shot, in order.`, phrasingImages, PHRASINGS_SCHEMA
    );
    const elementTypes = phrasingsResult.elementTypes ?? [];

    const textLines: { idx: number; box: [number, number, number, number]; content: string; role: string }[] = [];
    for (const [fi, framePath] of kf.framePaths.entries()) {
      const image = await loadImageDataUrl(framePath);
      const { result } = await extractFromImages<{ textLines: TextLineReading[] }>(opts.apiKey, opts.model, TEXT_LINES_SYSTEM, "This frame:", [image], TEXT_LINES_SCHEMA);
      for (const tl of result.textLines ?? []) textLines.push({ idx: kf.keyFrames[fi], ...tl });
    }

    let elements: ElementLayer[] = [];
    if (elementTypes.length) {
      log(`Shot ${i + 1}/${analysis.shots.length}: SAM detecting + tracking cards...`);
      const shotResult = await samCall<{ objects: RawSamElement[] }>(port, "/process_shot", {
        shotPath: shotClipPath, keyFrames: kf.keyFrames, framePaths: kf.framePaths, elementTypes,
      });
      elements = elements.concat(await buildCardElements(shotResult.objects, nextMediaIndex));
    }
    if (textLines.length) {
      log(`Shot ${i + 1}/${analysis.shots.length}: SAM tracking text...`);
      const textResult = await samCall<{ textObjects: RawSamTextElement[] }>(port, "/process_text_lines", {
        shotPath: shotClipPath, frameW: analysis.width, frameH: analysis.height, textLines,
      });
      elements = elements.concat(await buildTextElements(textResult.textObjects, shot.endMs - shot.startMs));
    }

    shots.push({ ...shot, elements: elements.length ? elements : undefined });
  }

  log("Rebuilding with new media...");
  const fullAnalysis: TemplateAnalysis = { ...analysis, shots, transitions: [], textBeats: [] };
  return rebuildFromAnalysis(fullAnalysis, opts.newMedia, io, opts.outPath);
}
