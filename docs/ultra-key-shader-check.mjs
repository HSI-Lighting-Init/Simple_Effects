// Dev-only WP11 shader check: renders the real Ultra Key passes in the live app
// (CDP on the WebView2 debug port) and compares them with the oracle,
// docs/ultra-key-reference.mjs. The 64×64 stress frame (random RGB, near-key
// greens, alpha ramp) covers the key pass, the Choke/Soften/Contrast cleanup,
// all three output modes, and the radius scaling at downsample 0.5. Composite
// RGB is compared premultiplied by the oracle's alpha; Alpha/Color RGB directly
// (their output is opaque).
//
// Usage:
//   1. WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//   2. npm run tauri dev   (or the debug exe + npm run dev)
//   3. node docs/ultra-key-shader-check.mjs
//
// Pass: mean absolute error ≤ 2/255 on every channel, alpha p99 ≤ 8/255.
// readPixels is used (not a 2D canvas): a 2D canvas premultiplies and destroys
// RGB where alpha is near 0, while the oracle keeps it.
import { ultraKey } from "./ultra-key-reference.mjs";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((p) => p.type === "page");
if (!page) throw new Error("no CDP page target — start the app with the debug port");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params) =>
  new Promise((res) => {
    const id = ++nextId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalPage = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails, null, 2));
  return r.result?.result?.value;
};
await send("Runtime.enable", {});

const summarise = (ds) => {
  ds.sort((a, b) => a - b);
  const mean = ds.reduce((s, v) => s + v, 0) / ds.length;
  return { mean: +mean.toFixed(3), p99: ds[Math.floor(ds.length * 0.99)], max: ds[ds.length - 1] };
};

const stats = (channel, out, oracle) => {
  const ds = [];
  for (let i = channel; i < out.length; i += 4) ds.push(Math.abs(out[i] - oracle[i]));
  return summarise(ds);
};

// The visible error of a soft key: RGB weighted by the oracle's alpha. Alpha
// itself stays a direct comparison.
const statsPremul = (channel, out, oracle) => {
  const ds = [];
  for (let i = 0; i < out.length; i += 4) {
    const a = oracle[i + 3] / 255;
    ds.push(Math.abs(out[i + channel] * a - oracle[i + channel] * a));
  }
  return summarise(ds);
};

const cases = [
  { label: "default (identity CC)", args: {} },
  { label: "contrast 30: one fully keyed pixel and one opaque pixel", args: { variant: "contrast", contrast: 30 } },
  { label: "CC saturation 150 / hue 30 / luminance 120", args: { saturation: 150, hue: 30, luminance: 120 } },
  {
    label: "stress 64x64 (random RGB, near-key band, alpha ramp)",
    args: { variant: "stress" },
    premultiplied: true,
  },
  {
    label: "stress: Default + Choke 30 / Soften 40 / Contrast 30",
    args: { variant: "stress", choke: 30, soften: 40, contrast: 30 },
    premultiplied: true,
  },
  {
    label: "stress: Aggressive preset",
    args: { variant: "stress", preset: 2 },
    premultiplied: true,
  },
  { label: "stress: Alpha Channel output", args: { variant: "stress", output: 1 } },
  { label: "stress: Color Channel output", args: { variant: "stress", output: 2 } },
  {
    label: "stress: Default + Choke 30 / Soften 40 / Contrast 30, downsample 0.5",
    args: { variant: "stress", choke: 30, soften: 40, contrast: 30, downsample: 0.5 },
    premultiplied: true,
  },
];
let allPass = true;
for (const c of cases) {
  const frame = await evalPage(`window.__sefxUltraKey?.check(${JSON.stringify(c.args)})`);
  if (!frame) throw new Error("window.__sefxUltraKey is missing — is the app in dev mode?");
  if (frame.error) throw new Error(`shader check failed to render: ${frame.error}`);
  const { w, h, input, params, key, pixels } = frame;
  const outputName = ["composite", "alpha", "color"][frame.output] ?? "composite";
  const oracle = ultraKey(new Uint8ClampedArray(input), w, h, key, params, outputName, frame.downsample);

  // readPixels is bottom-up; the oracle is top-down.
  const px = Uint8Array.from(pixels);
  const out = new Uint8Array(px.length);
  for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);

  const rgb = c.premultiplied ? statsPremul : stats;
  const report = { r: rgb(0, out, oracle), g: rgb(1, out, oracle), b: rgb(2, out, oracle), a: stats(3, out, oracle) };
  const pass =
    report.r.mean <= 2 && report.g.mean <= 2 && report.b.mean <= 2 && report.a.mean <= 2 && report.a.p99 <= 8;
  allPass = allPass && pass;
  console.log(JSON.stringify({ case: c.label, premultipliedRgb: !!c.premultiplied, report }, null, 2));
  if (process.env.UK_DEBUG) {
    const at = (arr, x, y) => Array.from(arr.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
    console.log([[2,2],[5,5],[20,5],[5,20],[18,20],[26,22],[14,10],[30,30]].map(([x,y]) => ({x,y,out:at(out,x,y),oracle:at(oracle,x,y)})));
  }
  console.log(
    `${pass ? "PASS" : "FAIL"} — ${c.label}: mean r/g/b/a ${report.r.mean}/${report.g.mean}/${report.b.mean}/${report.a.mean}, alpha p99 ${report.a.p99} (limits: 2 mean, 8 alpha p99)`
  );
}
ws.close();
if (!allPass) process.exit(1);
