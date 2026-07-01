// Headless canvas mock for the transition unit tests.
//
// jsdom/node don't rasterise <canvas>, so we install a stub 2D context whose
// drawing calls are no-ops and whose data-returning calls return valid-shaped
// (zeroed) results. This lets every transition's render() code path execute
// end-to-end — catching exceptions, bad params and logic errors — without a GPU
// or real pixels. It does not verify visual output (that needs the browser).

const CTX_PROP_DEFAULTS: Record<string, unknown> = {
  globalAlpha: 1,
  globalCompositeOperation: "source-over",
  filter: "none",
  fillStyle: "#000",
  strokeStyle: "#000",
  lineWidth: 1,
  font: "10px sans-serif",
  textAlign: "start",
  textBaseline: "alphabetic",
  imageSmoothingEnabled: true,
  shadowBlur: 0,
  shadowColor: "rgba(0,0,0,0)",
  lineCap: "butt",
  lineJoin: "miter",
};

function makeContext(canvas: { width: number; height: number }) {
  const grad = () => ({ addColorStop() {} });
  const store: Record<string, unknown> = { ...CTX_PROP_DEFAULTS, canvas };
  const methods: Record<string, (...a: unknown[]) => unknown> = {
    getImageData: (_x, _y, w, h) => {
      const ww = Math.max(1, Number(w) || canvas.width || 1);
      const hh = Math.max(1, Number(h) || canvas.height || 1);
      return { data: new Uint8ClampedArray(ww * hh * 4), width: ww, height: hh };
    },
    createImageData: (w, h) => {
      const ww = Math.max(1, Number((w as { width?: number })?.width ?? w) || 1);
      const hh = Math.max(1, Number((w as { height?: number })?.height ?? h) || 1);
      return { data: new Uint8ClampedArray(ww * hh * 4), width: ww, height: hh };
    },
    createLinearGradient: grad,
    createRadialGradient: grad,
    createPattern: () => ({}),
    measureText: () => ({ width: 0 }),
  };
  return new Proxy(store, {
    get(target, prop: string) {
      if (prop in methods) return methods[prop];
      if (prop in target) return target[prop];
      return () => {}; // any other draw call → no-op
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
}

function makeCanvas(width = 300, height = 150) {
  const canvas: Record<string, unknown> = { width, height };
  canvas.getContext = (type: string) => (type === "2d" ? makeContext(canvas as { width: number; height: number }) : null);
  canvas.toDataURL = () => "data:image/png;base64,";
  return canvas;
}

const g = globalThis as Record<string, unknown>;
if (!g.document) {
  g.document = {
    createElement: (tag: string) => (tag === "canvas" ? makeCanvas() : { tagName: tag }),
  };
}

export { makeCanvas };
