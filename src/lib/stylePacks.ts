// Style packs: named "looks" (Instagram Block, News Studio, Traveller's Choice…).
// Each pack is pure data mapping a style to concrete engine choices — grade effects,
// hero-shot accents, whole-video overlays, Ken Burns motion, a transition family and
// a text recipe (font, color, stroke/glow/shadow, animation, color block / lower-
// third bar). ONE generic applier drives the existing engine APIs, so there is no
// per-pack code and no new engine logic. Used by the Style Packs dialog and the
// agent's list_styles / apply_style tools.
import type { Project } from "../bindings/Project";
import type { Layer } from "../bindings/Layer";
import type { Rgba } from "../bindings/Rgba";
import type { LetterPreset } from "../bindings/LetterPreset";
import type { Shape2DStyle } from "../bindings/Shape2DStyle";
import {
  addEffect,
  removeEffect,
  keyEffect,
  editKeyframes,
  setLayerTransition,
  setLayerRange,
  deleteLayer,
  renameLayer,
  reorderLayers,
  addAdjustmentLayer,
  addShape2dLayer,
  setShape2d,
  getShaped,
  setTextContent,
  setTextFont,
  setTextFontStyle,
  clearTextColorKeys,
  setTextStyle,
  setTextLayerStyles,
  setTextAnim,
  setTextAnimOut,
  type EffectParam,
} from "./api";
import { sampleTrack, constTrack } from "./track";

export type FxKind =
  | "brightness" | "contrast" | "saturate" | "hue" | "blur" | "grayscale" | "invert"
  | "filmgrain" | "vignette" | "shimmer" | "sparkle" | "lensflare" | "aurora" | "fog"
  | "caustics" | "heathaze" | "shinyclouds";
export interface FxSpec {
  kind: FxKind;
  /** Overrides on the engine's tuned defaults (keyed as constants). */
  params?: Partial<Record<EffectParam, number>>;
}
interface TextRecipe {
  font: string;
  weight: number;
  italic?: boolean;
  color: Rgba;
  /** Font px = sizeRatio × the composition's short side (auto-shrunk to fit). */
  sizeRatio: number;
  tracking?: number;
  stroke?: { color: Rgba; width: number };
  shadow?: { color: Rgba; opacity: number; distance: number; size: number };
  glow?: { color: Rgba; opacity: number; size: number };
  animIn: { preset: LetterPreset; durationMs: number; staggerMs: number; areaPx?: number };
  /** block = a color plate hugging the text; bar = a full-width lower-third band. */
  block?: { kind: "block" | "bar"; color: Rgba; radius: number; padX: number; padY: number; accent?: Rgba };
  position?: "keep" | "lowerThird";
}
export interface StylePack {
  id: string;
  name: string;
  category: string;
  /** What it looks like and when to use it — what matching (human or model) reads. */
  description: string;
  keywords: string[];
  palette: Rgba[];
  /** Suggested pace per shot, for whoever is cutting the timeline. */
  shotMs: number;
  /** On every image/video layer. */
  grade: FxSpec[];
  /** Extra on the first and last clip (the hero shots). */
  accent?: FxSpec[];
  /** Whole-video, via one adjustment layer under the titles. */
  overlay?: FxSpec[];
  /** Ken Burns across each shot: scale ×zoom, drift ±pan (fraction of width). */
  motion: { zoom: number; pan: number };
  transitions: { engines: string[]; durMs: number };
  text: TextRecipe;
}

const hex = (h: string, a = 255): Rgba => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
  a,
});
const fx = (kind: FxKind, params?: FxSpec["params"]): FxSpec => ({ kind, params });
const WHITE = hex("#FFFFFF");
const BLACK = hex("#000000");

/** These GPU effects displace or resample the pixels under them (grain adds
 *  noise to real content, vignette/heat-haze darken/warp it), so they can't
 *  run as a shared whole-video overlay the way shiny clouds / sparkle / aurora
 *  etc. can — the shader has nothing to read on an adjustment layer and skips
 *  them. The applier gives these to every clip directly instead. */
const DIRECT_FX: ReadonlySet<FxKind> = new Set(["filmgrain", "vignette", "heathaze"]);

export const STYLE_PACKS: StylePack[] = [
  {
    id: "instagram-block",
    name: "Instagram Block",
    category: "Social",
    description:
      "Bold, colorful social-feed look: chunky white type on solid color blocks, fast ~1s cuts, a vibrant pop grade, and energetic zoom / push / whip transitions. For reels, promos, launches, sales and announcements.",
    keywords: ["instagram", "insta", "reel", "reels", "tiktok", "social", "promo", "promotion", "sale", "launch", "bold", "pop", "vibrant", "upbeat", "energetic", "trendy", "viral", "feed"],
    palette: [hex("#FF2E63"), hex("#FFD60A"), WHITE],
    shotMs: 1000,
    grade: [fx("saturate", { amount: 1.3 }), fx("contrast", { amount: 1.12 })],
    accent: [fx("shimmer", { opacity: 0.25 })],
    motion: { zoom: 1.12, pan: 0 },
    transitions: { engines: ["zoomIn", "push", "whipPan", "scaleBounce"], durMs: 320 },
    text: {
      font: "Impact", weight: 400, color: WHITE, sizeRatio: 0.1, tracking: 1,
      shadow: { color: BLACK, opacity: 0.35, distance: 6, size: 10 },
      animIn: { preset: "scalePop", durationMs: 420, staggerMs: 35 },
      block: { kind: "block", color: hex("#FF2E63"), radius: 18, padX: 36, padY: 22 },
    },
  },
  {
    id: "travellers-choice",
    name: "Traveller's Choice",
    category: "Travel & Lifestyle",
    description:
      "Warm, cinematic travel-vlog feel: golden-hour grade, soft film grain and vignette, slow Ken Burns drift, gentle dissolves and light leaks, elegant italic serif titles. For travel, tourism, hotels, adventure and lifestyle stories.",
    keywords: ["travel", "traveller", "traveler", "trip", "vacation", "holiday", "tourism", "tour", "hotel", "resort", "adventure", "journey", "explore", "destination", "vlog", "wanderlust", "beach", "mountain", "cinematic", "warm"],
    palette: [hex("#F4A259"), hex("#FFF4E0"), hex("#5B8E7D")],
    shotMs: 2600,
    grade: [fx("saturate", { amount: 1.12 }), fx("contrast", { amount: 1.05 }), fx("brightness", { amount: 1.04 })],
    overlay: [fx("filmgrain", { intensity: 0.15, opacity: 0.55 }), fx("vignette", { intensity: 0.6 })],
    motion: { zoom: 1.1, pan: 0.03 },
    transitions: { engines: ["crossDissolve", "lightLeak", "fade", "dipToWhite"], durMs: 700 },
    text: {
      font: "Georgia", weight: 400, italic: true, color: hex("#FFF4E0"), sizeRatio: 0.085, tracking: 1,
      shadow: { color: BLACK, opacity: 0.55, distance: 4, size: 14 },
      animIn: { preset: "riseUp", durationMs: 700, staggerMs: 55 },
    },
  },
  {
    id: "news-studio",
    name: "News Studio",
    category: "News & Business",
    description:
      "Broadcast news look: crisp neutral grade, a bold lower-third headline bar in newsroom blue with a red accent tab, typewriter headline reveal, clean push and wipe transitions, slow B-roll push-ins. For announcements, press releases, company news, reports and updates.",
    keywords: ["news", "breaking", "report", "reporting", "press", "announcement", "announce", "update", "headline", "business", "corporate", "company", "media", "broadcast", "studio", "live", "journalism", "bulletin"],
    palette: [hex("#0B3D91"), hex("#D7263D"), WHITE],
    shotMs: 3000,
    grade: [fx("contrast", { amount: 1.08 }), fx("brightness", { amount: 1.02 })],
    motion: { zoom: 1.05, pan: 0 },
    transitions: { engines: ["push", "horizontalWipe", "slide", "softWipe"], durMs: 400 },
    text: {
      font: "Arial", weight: 700, color: WHITE, sizeRatio: 0.055, tracking: 0.5,
      animIn: { preset: "typewriter", durationMs: 60, staggerMs: 35 },
      block: { kind: "bar", color: hex("#0B3D91"), radius: 4, padX: 40, padY: 26, accent: hex("#D7263D") },
      position: "lowerThird",
    },
  },
  {
    id: "luxury-gold",
    name: "Luxury Gold",
    category: "Premium & Fashion",
    description:
      "Premium and elegant: deep contrast with muted color, slow push-ins, long dissolves and dips to black, gold serif type with a warm glow, a strong vignette and delicate sparkle. For luxury brands, jewelry, fashion, perfume and high-end products.",
    keywords: ["luxury", "premium", "elegant", "gold", "golden", "fashion", "jewelry", "jewellery", "high end", "exclusive", "classy", "boutique", "perfume", "watch", "vip", "sophisticated", "couture"],
    palette: [hex("#D4AF37"), hex("#1A1A1A"), hex("#F5E6C8")],
    shotMs: 3000,
    grade: [fx("contrast", { amount: 1.15 }), fx("saturate", { amount: 0.9 }), fx("brightness", { amount: 0.97 })],
    accent: [fx("sparkle", { opacity: 0.45 })],
    overlay: [fx("vignette", { intensity: 0.85 })],
    motion: { zoom: 1.08, pan: 0 },
    transitions: { engines: ["crossDissolve", "dipToBlack", "fade"], durMs: 900 },
    text: {
      font: "Georgia", weight: 400, color: hex("#D4AF37"), sizeRatio: 0.08, tracking: 6,
      glow: { color: hex("#D4AF37"), opacity: 0.55, size: 18 },
      animIn: { preset: "fadeIn", durationMs: 900, staggerMs: 70 },
    },
  },
  {
    id: "tech-neon",
    name: "Tech Neon",
    category: "Tech & Gaming",
    description:
      "Futuristic tech / gaming vibe: dark, high-contrast grade, neon cyan glowing type, glitch and digital transitions, an aurora light wash, fast cuts. For apps, software, AI, gadgets, gaming, esports and startups.",
    keywords: ["tech", "technology", "app", "software", "saas", "ai", "artificial intelligence", "gaming", "game", "gamer", "esports", "futuristic", "neon", "cyber", "cyberpunk", "digital", "startup", "gadget", "code", "robot", "electronics"],
    palette: [hex("#00F0FF"), hex("#FF00E5"), hex("#0A0A12")],
    shotMs: 1200,
    grade: [fx("contrast", { amount: 1.2 }), fx("saturate", { amount: 1.25 }), fx("brightness", { amount: 0.95 })],
    overlay: [fx("aurora", { opacity: 0.3 }), fx("vignette", { intensity: 0.7 })],
    motion: { zoom: 1.08, pan: 0 },
    transitions: { engines: ["glitch", "digitalBlockWipe", "zoomMotionBlur", "pixelSort"], durMs: 350 },
    text: {
      font: "Bahnschrift", weight: 700, color: hex("#00F0FF"), sizeRatio: 0.085, tracking: 3,
      glow: { color: hex("#00F0FF"), opacity: 0.9, size: 22 },
      animIn: { preset: "scatterIn", durationMs: 600, staggerMs: 25, areaPx: 500 },
    },
  },
  {
    id: "minimal-clean",
    name: "Minimal Clean",
    category: "Corporate & Product",
    description:
      "Calm, minimal and modern: natural color, soft fades, barely-there motion, thin sans-serif type with generous letter spacing, no heavy effects. For corporate videos, product demos, portfolios, architecture and clean brand pieces.",
    keywords: ["minimal", "minimalist", "clean", "simple", "modern", "corporate", "professional", "product", "portfolio", "architecture", "calm", "sleek", "demo", "presentation", "brand"],
    palette: [WHITE, hex("#111111"), hex("#9CA3AF")],
    shotMs: 2500,
    grade: [fx("contrast", { amount: 1.03 })],
    motion: { zoom: 1.04, pan: 0 },
    transitions: { engines: ["fade", "crossDissolve", "softWipe"], durMs: 500 },
    text: {
      font: "Segoe UI", weight: 300, color: WHITE, sizeRatio: 0.07, tracking: 5,
      shadow: { color: BLACK, opacity: 0.3, distance: 2, size: 8 },
      animIn: { preset: "fadeIn", durationMs: 600, staggerMs: 25 },
    },
  },
  {
    id: "retro-film",
    name: "Retro Film",
    category: "Vintage",
    description:
      "Nostalgic vintage film: faded, warm, desaturated grade, heavy film grain, a strong vignette, flicker and VHS-style transitions, typewriter titles in a cream monospace. For throwbacks, anniversaries, heritage stories and retro brands.",
    keywords: ["retro", "vintage", "film", "old", "nostalgia", "nostalgic", "vhs", "80s", "90s", "70s", "throwback", "classic", "heritage", "memories", "memory", "anniversary", "history", "old school"],
    palette: [hex("#C9A227"), hex("#F3E9D2"), hex("#6B4F3A")],
    shotMs: 2200,
    grade: [fx("saturate", { amount: 0.72 }), fx("contrast", { amount: 1.1 }), fx("brightness", { amount: 1.03 })],
    overlay: [fx("filmgrain", { intensity: 0.4, opacity: 0.85 }), fx("vignette", { intensity: 0.95 })],
    motion: { zoom: 1.06, pan: 0.02 },
    transitions: { engines: ["flicker", "retroVHS", "dipToBlack", "badTV"], durMs: 500 },
    text: {
      font: "Courier New", weight: 700, color: hex("#F3E9D2"), sizeRatio: 0.07, tracking: 2,
      shadow: { color: BLACK, opacity: 0.6, distance: 4, size: 6 },
      animIn: { preset: "typewriter", durationMs: 60, staggerMs: 70 },
    },
  },
  {
    id: "real-estate",
    name: "Real Estate Showcase",
    category: "Property & Interiors",
    description:
      "Bright, airy property tour: lifted exposure and clean natural color, smooth slow pans and push-ins, soft dissolves, and a tidy dark lower-third info bar with a green accent. For real estate listings, interiors, lighting, rentals, hotels and architecture walkthroughs.",
    keywords: ["real estate", "property", "properties", "house", "home", "homes", "apartment", "condo", "interior", "interiors", "rental", "listing", "villa", "room", "rooms", "lighting", "living room", "renovation", "design"],
    palette: [hex("#1F2937"), hex("#10B981"), WHITE],
    shotMs: 3000,
    grade: [fx("brightness", { amount: 1.08 }), fx("contrast", { amount: 1.04 }), fx("saturate", { amount: 1.06 })],
    motion: { zoom: 1.1, pan: 0.035 },
    transitions: { engines: ["crossDissolve", "fade", "softWipe"], durMs: 700 },
    text: {
      font: "Segoe UI", weight: 600, color: WHITE, sizeRatio: 0.055, tracking: 1,
      animIn: { preset: "riseUp", durationMs: 600, staggerMs: 30 },
      block: { kind: "bar", color: hex("#1F2937", 225), radius: 8, padX: 36, padY: 24, accent: hex("#10B981") },
      position: "lowerThird",
    },
  },
  {
    id: "food-restaurant",
    name: "Food & Restaurant",
    category: "Food & Hospitality",
    description:
      "Appetizing and warm: rich saturated grade, soft vignette, punchy zoom-ins, lively quick cuts, and playful bold italic titles on a warm color block. For restaurants, cafes, recipes, food brands, menus and bakeries.",
    keywords: ["food", "restaurant", "cafe", "coffee", "recipe", "menu", "bakery", "kitchen", "chef", "dish", "delicious", "eat", "eating", "dinner", "lunch", "breakfast", "pizza", "burger", "dessert", "cooking"],
    palette: [hex("#E4572E"), hex("#FFC857"), WHITE],
    shotMs: 1500,
    grade: [fx("saturate", { amount: 1.3 }), fx("contrast", { amount: 1.08 }), fx("brightness", { amount: 1.05 })],
    overlay: [fx("vignette", { intensity: 0.5 })],
    motion: { zoom: 1.12, pan: 0 },
    transitions: { engines: ["zoomIn", "slide", "scaleBounce", "whipPan"], durMs: 350 },
    text: {
      font: "Georgia", weight: 700, italic: true, color: WHITE, sizeRatio: 0.09, tracking: 0,
      animIn: { preset: "scalePop", durationMs: 450, staggerMs: 40 },
      block: { kind: "block", color: hex("#E4572E"), radius: 26, padX: 34, padY: 20 },
    },
  },
  {
    id: "sports-energy",
    name: "Sports Energy",
    category: "Sports & Fitness",
    description:
      "High-energy hype: punchy high-contrast grade, very fast cuts, whip pans, zoom-shakes and motion-blur zooms, bold italic outlined type, lens-flare accents on the hero shots. For sports, gyms, fitness, events, trailers and hype videos.",
    keywords: ["sports", "sport", "fitness", "gym", "workout", "training", "match", "hype", "trailer", "action", "race", "racing", "extreme", "energy", "athlete", "football", "soccer", "basketball", "run", "running", "competition"],
    palette: [hex("#FF3B30"), hex("#FFD60A"), hex("#111111")],
    shotMs: 800,
    grade: [fx("contrast", { amount: 1.25 }), fx("saturate", { amount: 1.2 })],
    accent: [fx("lensflare", { opacity: 0.7 })],
    overlay: [fx("vignette", { intensity: 0.7 })],
    motion: { zoom: 1.15, pan: 0 },
    transitions: { engines: ["whipPan", "zoomShake", "zoomMotionBlur", "tiltWhip"], durMs: 260 },
    text: {
      font: "Impact", weight: 400, italic: true, color: WHITE, sizeRatio: 0.11, tracking: 1,
      stroke: { color: BLACK, width: 6 },
      animIn: { preset: "scalePop", durationMs: 350, staggerMs: 25 },
    },
  },
  {
    id: "kids-fun",
    name: "Kids & Fun",
    category: "Family & Kids",
    description:
      "Playful and bright: candy colors, bouncy scale and spin transitions, confetti and bubble reveals, sparkles, and rounded friendly type on a colorful block. For kids, toys, birthdays, parties, family events and schools.",
    keywords: ["kids", "kid", "children", "child", "toy", "toys", "birthday", "party", "fun", "family", "school", "playful", "colorful", "colourful", "celebration", "cartoon", "baby", "games"],
    palette: [hex("#7B2FF7"), hex("#FFD60A"), hex("#FF5FA2")],
    shotMs: 1500,
    grade: [fx("saturate", { amount: 1.35 }), fx("brightness", { amount: 1.06 })],
    overlay: [fx("sparkle", { opacity: 0.45 })],
    motion: { zoom: 1.1, pan: 0 },
    transitions: { engines: ["confetti", "scaleBounce", "bubbles", "spin2d"], durMs: 550 },
    text: {
      font: "Comic Sans MS", weight: 700, color: WHITE, sizeRatio: 0.09, tracking: 1,
      shadow: { color: BLACK, opacity: 0.3, distance: 5, size: 8 },
      animIn: { preset: "scalePop", durationMs: 500, staggerMs: 45 },
      block: { kind: "block", color: hex("#7B2FF7"), radius: 40, padX: 40, padY: 24 },
    },
  },
  {
    id: "wedding-romance",
    name: "Wedding & Romance",
    category: "Events",
    description:
      "Soft, dreamy and romantic: light airy grade with lowered contrast, slow dissolves and dips to white, a gentle shimmer and sparkle, graceful script titles with a soft white glow. For weddings, engagements, anniversaries, love stories and beauty brands.",
    keywords: ["wedding", "marriage", "married", "bride", "groom", "engagement", "engaged", "love", "romance", "romantic", "anniversary", "couple", "dreamy", "soft", "beauty", "bridal", "valentine", "proposal"],
    palette: [hex("#F7C6D0"), WHITE, hex("#C9A7EB")],
    shotMs: 3000,
    grade: [fx("brightness", { amount: 1.07 }), fx("contrast", { amount: 0.94 }), fx("saturate", { amount: 1.05 })],
    overlay: [fx("shimmer", { opacity: 0.18 }), fx("sparkle", { opacity: 0.3 })],
    motion: { zoom: 1.06, pan: 0.015 },
    transitions: { engines: ["crossDissolve", "dipToWhite", "fade"], durMs: 1000 },
    text: {
      font: "Segoe Script", weight: 400, color: WHITE, sizeRatio: 0.08, tracking: 0,
      glow: { color: WHITE, opacity: 0.7, size: 18 },
      animIn: { preset: "fadeIn", durationMs: 900, staggerMs: 80 },
    },
  },
];

export const stylePackById = (id: string) => STYLE_PACKS.find((p) => p.id === id);

/** Rank packs against a free-text description by keyword hits (multi-word = 2). */
export function matchStyles(text: string): { pack: StylePack; score: number }[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return STYLE_PACKS.map((pack) => ({
    pack,
    score: pack.keywords.reduce((s, k) => s + (t.includes(` ${k} `) ? (k.includes(" ") ? 2 : 1) : 0), 0),
  })).sort((a, b) => b.score - a.score);
}

/** Best pack for a description; Minimal Clean when nothing matches. */
export function bestStyle(text: string): StylePack {
  const [top] = matchStyles(text);
  return top && top.score > 0 ? top.pack : stylePackById("minimal-clean")!;
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

/** Layers the applier creates carry this prefix, so re-applying swaps the look. */
const TAG = "Style · ";

export interface StyleIO {
  project(): Project;
  commit(p: Project): Promise<void>;
}
export interface StyleResult {
  style: string;
  clips: number;
  titles: number;
  overlays: string[];
  transitions: string[];
}

const byId = (p: Project, id: number): Layer => {
  const l = p.layers.find((x) => x.id === id);
  if (!l) throw new Error(`layer ${id} vanished while styling`);
  return l;
};

async function addFx(layerId: number, spec: FxSpec): Promise<Project> {
  let p = await addEffect(layerId, spec.kind);
  const index = byId(p, layerId).effects.length - 1;
  for (const [param, value] of Object.entries(spec.params ?? {}))
    p = await keyEffect(layerId, index, param as EffectParam, 0, value as number, false);
  return p;
}

async function clearFx(p: Project, layerId: number): Promise<Project> {
  for (let k = byId(p, layerId).effects.length - 1; k >= 0; k--) p = await removeEffect(layerId, k);
  return p;
}

/** Slot `id` directly below `belowId` in the (bottom-first) stack. */
async function placeBelow(p: Project, id: number, belowId: number): Promise<Project> {
  const order = p.layers.map((l) => l.id).filter((x) => x !== id);
  const at = order.indexOf(belowId);
  order.splice(at < 0 ? order.length : at, 0, id);
  return reorderLayers(order);
}

/** Natural contain-fit scale of a clip in this comp (what add-media gives it). */
export function fitScale(l: Layer, W: number, H: number): number | null {
  const k = l.kind;
  if (k.kind === "image") {
    const w = k.crop ? k.crop.width : k.width;
    const h = k.crop ? k.crop.height : k.height;
    return Math.min(W / w, H / h);
  }
  if (k.kind === "video") return Math.min(W / k.width, H / k.height);
  return null;
}

/** Ken Burns: push-in / pull-out alternating per shot, optional lateral drift.
 *  Scales from the clip's natural fit (not its current scale) so re-applying a
 *  style never compounds. Picture-in-picture-sized clips are left alone. */
async function kenBurns(p: Project, l: Layer, i: number, motion: StylePack["motion"]): Promise<Project> {
  const W = p.width;
  const fit = fitScale(l, W, p.height);
  if (!fit || (motion.zoom === 1 && motion.pan === 0)) return p;
  const cur = sampleTrack(l.transform.scaleX, l.startMs);
  if (cur < fit * 0.85) return p; // an overlay / PiP clip — don't blow it up to full frame
  const ratio = sampleTrack(l.transform.scaleY, l.startMs) / (cur || 1);
  // Enough headroom that the drift never reveals an edge (+2% hides hairline bars).
  const s0 = fit * (1 + 2 * motion.pan) * 1.02;
  const s1 = s0 * motion.zoom;
  const [a, b] = i % 2 === 0 ? [s0, s1] : [s1, s0];
  const drift = motion.pan * W * (i % 2 === 0 ? 1 : -1);
  const x = (v: number) => (motion.pan ? { x: W / 2 + v } : {});
  p = await editKeyframes(l.id, l.startMs, { scaleX: a, scaleY: a * ratio, ...x(-drift) }, false);
  p = await editKeyframes(l.id, l.endMs, { scaleX: b, scaleY: b * ratio, ...x(drift) }, false);
  return p;
}

/** Apply a pack to the whole timeline. Replaces effects + in-transitions on clips,
 *  restyles every text layer, and swaps any previously applied style layers.
 *  The caller should checkpoint first (the tool and dialog both do). */
export async function applyStylePack(pack: StylePack, io: StyleIO): Promise<StyleResult> {
  let p = io.project();
  const W = p.width;
  const H = p.height;
  const S = Math.min(W, H);

  // 1. Drop layers created by a previously applied style.
  for (const id of p.layers.filter((l) => l.name.startsWith(TAG)).map((l) => l.id)) p = await deleteLayer(id);

  // 2. Clips: grade (+ hero accents), Ken Burns, a transition per cut.
  const clips = p.layers
    .filter((l) => (l.kind.kind === "image" || l.kind.kind === "video") && !l.hidden)
    .sort((a, b) => a.startMs - b.startMs);
  const used = new Set<string>();
  const directOverlay = (pack.overlay ?? []).filter((s) => DIRECT_FX.has(s.kind));
  for (const [i, c] of clips.entries()) {
    p = await clearFx(p, c.id);
    const hero = i === 0 || i === clips.length - 1;
    for (const spec of [...pack.grade, ...directOverlay, ...(hero ? pack.accent ?? [] : [])]) p = await addFx(c.id, spec);
    p = await kenBurns(p, byId(p, c.id), i, pack.motion);

    const engines = pack.transitions.engines;
    const engine = i === 0 ? "fade" : engines[(i - 1) % engines.length];
    const prev = clips[i - 1];
    const overlap = prev ? prev.endMs - c.startMs : 0;
    let dur = i === 0 ? 500 : pack.transitions.durMs;
    if (overlap > 0) dur = Math.min(dur, overlap); // a true crossfade inside the overlap
    dur = Math.max(100, Math.min(dur, Math.round((c.endMs - c.startMs) * 0.4)));
    p = await setLayerTransition(c.id, "in", "dissolve", dur, i % 2, engine);
    used.add(engine);
  }

  // 3. Titles: font, size, color, stroke / glow / shadow, animation, block or bar.
  const t = pack.text;
  const titles = p.layers.filter((l) => l.kind.kind === "text" && !l.hidden);
  for (const title of titles) {
    const k = title.kind;
    if (k.kind !== "text") continue;
    const id = title.id;
    let size = Math.round(t.sizeRatio * S);
    p = await setTextContent(id, k.content, size);
    p = await setTextFont(id, t.font);
    p = await setTextFontStyle(id, t.weight, !!t.italic);
    // Shrink to fit (88% of the frame width) so no pack ever overflows.
    let shaped = await getShaped(id);
    const sc = sampleTrack(byId(p, id).transform.scaleX, title.startMs) || 1;
    if (shaped && shaped.width * sc > W * 0.88) {
      size = Math.max(12, Math.floor((size * W * 0.88) / (shaped.width * sc)));
      p = await setTextContent(id, k.content, size);
      shaped = await getShaped(id);
    }
    p = await clearTextColorKeys(id, t.color);
    p = await setTextStyle(id, {
      fills: [],
      strokes: t.stroke ? [{ color: t.stroke.color, opacity: 100, width: t.stroke.width, position: "outside" }] : [],
      fillOverStroke: false,
      tracking: constTrack(t.tracking ?? 0),
      leading: 0,
      baselineShift: constTrack(0),
      fontFamily: null,
      fallbackStack: [],
      fontStyle: null,
      variableAxes: {},
    });
    p = await setTextLayerStyles(id, {
      dropShadow: t.shadow ? { ...t.shadow, angle: 120 } : null,
      outerGlow: t.glow ? { ...t.glow, range: 50, mode: "screen" } : null,
      innerGlow: null,
      bevel: null,
      gradient: null,
    });
    const a = t.animIn;
    p = await setTextAnim(id, { preset: a.preset, startMs: t.block ? 200 : 0, durationMs: a.durationMs, staggerMs: a.staggerMs, areaPx: a.areaPx ?? 400, reverse: false });
    p = await setTextAnimOut(id, { preset: "fadeIn", startMs: 0, durationMs: 300, staggerMs: 0, areaPx: 0, reverse: false });
    if (t.position === "lowerThird") p = await editKeyframes(id, title.startMs, { x: W / 2, y: H * 0.82 }, false);

    if (t.block && shaped) {
      const tl = byId(p, id);
      const tx = sampleTrack(tl.transform.x, tl.startMs);
      const ty = sampleTrack(tl.transform.y, tl.startMs);
      const tw = shaped.width * sc;
      const th = (shaped.ascender + shaped.descender + (Math.max(1, shaped.lines) - 1) * shaped.lineHeight) * sc;
      const b = t.block;
      const bw = b.kind === "bar" ? W * 0.92 : tw + b.padX * 2;
      const bh = th + b.padY * 2;
      const plates: { w: number; x: number; color: Rgba; name: string }[] = [{ w: bw, x: tx, color: b.color, name: "block" }];
      if (b.accent) plates.push({ w: W * 0.022, x: tx - bw / 2 + W * 0.011, color: b.accent, name: "accent" });
      for (const plate of plates) {
        p = await addShape2dLayer("rectangle");
        const sid = p.layers[p.layers.length - 1].id;
        const sk = byId(p, sid).kind;
        if (sk.kind !== "shape2d") continue;
        const style: Shape2DStyle = {
          ...sk.style,
          width: constTrack(plate.w),
          height: constTrack(bh),
          cornerRadius: constTrack(plate.name === "accent" ? 0 : b.radius),
          filled: true,
          fill: plate.color,
          fillKeys: [],
          borderWidth: constTrack(0),
          glowOpacity: constTrack(0),
          glowSize: constTrack(0),
          shadowOpacity: constTrack(plate.name === "accent" ? 0 : 0.35),
          shadowBlur: constTrack(18),
          shadowOffsetX: constTrack(0),
          shadowOffsetY: constTrack(6),
        };
        p = await setShape2d(sid, style);
        p = await setLayerRange(sid, tl.startMs, tl.endMs);
        p = await editKeyframes(sid, tl.startMs, { x: plate.x, y: ty }, false);
        p = await setLayerTransition(sid, "in", "dissolve", 350, 0, b.kind === "bar" ? "horizontalWipe" : "scaleUp");
        p = await setLayerTransition(sid, "out", "dissolve", 300, 0, "fade");
        p = await renameLayer(sid, TAG + plate.name);
        p = await placeBelow(p, sid, id); // plate sits right under its title
      }
    }
  }

  // 4. Whole-video overlay on one adjustment layer, kept under the titles so they stay crisp.
  //    (Direct per-pixel kinds — grain/vignette/heat-haze — already went on every
  //    clip above; only the compositable kinds belong here.)
  const overlays: string[] = directOverlay.map((s) => s.kind);
  const adjustmentFx = (pack.overlay ?? []).filter((s) => !DIRECT_FX.has(s.kind));
  if (adjustmentFx.length) {
    p = await addAdjustmentLayer();
    const aid = p.layers[p.layers.length - 1].id;
    p = await clearFx(p, aid); // it arrives seeded with shiny clouds
    for (const spec of adjustmentFx) {
      p = await addFx(aid, spec);
      overlays.push(spec.kind);
    }
    p = await setLayerRange(aid, 0, p.durationMs);
    p = await renameLayer(aid, TAG + "overlay");
    const lowest = p.layers.find((l) => l.id !== aid && (l.kind.kind === "text" || l.name.startsWith(TAG + "block") || l.name.startsWith(TAG + "accent")));
    if (lowest) p = await placeBelow(p, aid, lowest.id);
  }

  await io.commit(p);
  return { style: pack.name, clips: clips.length, titles: titles.length, overlays, transitions: [...used] };
}
